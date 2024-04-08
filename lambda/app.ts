import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'; import * as AWS from 'aws-sdk'; import axios from 'axios';
const s3 = new AWS.S3();
const bucketName = process.env.S3_BUCKET_NAME;
const apiUrl = process.env.API_URL;
const maxBlocksPerRun = parseInt(process.env.MAX_BLOCKS_PER_RUN || '1000', 10);
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!bucketName) {
            throw new Error('S3_BUCKET_NAME environment variable is not set');
        }
        if (!apiUrl) {
            throw new Error('API_URL environment variable is not set');
        }
        if (!discordWebhookUrl) {
            throw new Error('DISCORD_WEBHOOK_URL environment variable is not set');
        }

        // Read data.json from S3
        const params: AWS.S3.GetObjectRequest = {
            Bucket: bucketName,
            Key: 'data.json',
        };
        const data = await s3.getObject(params).promise();

        // Check if data.Body is defined
        if (!data.Body) {
            throw new Error('Empty data received from S3');
        }
        const jsonData = JSON.parse(data.Body.toString());

        // Check if the last Lambda function is still running
        if (jsonData.active) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Lambda function is still running, exiting.',
                }),
            };
        }

        // Set the active flag to true so that next Lambda function can exit early if it detects it's still running
        jsonData.active = true;
        await s3.putObject({
            Bucket: bucketName,
            Key: 'data.json',
            Body: JSON.stringify(jsonData),
        }).promise();
        let lastBlock = jsonData.last_block;
        let lastIrreversibleBlock = 0;

        // Make the initial API call to get the last irreversible block
        const initialResponse = await axios.post(`${apiUrl}/v1/history/get_block_txids`, {
            block_num: lastBlock + 1,
        });
        lastIrreversibleBlock = initialResponse.data.last_irreversible_block;
        const maxBlockNum = Math.min(lastBlock + maxBlocksPerRun, lastIrreversibleBlock);
        const registeredFioDomains: string[] = [];
        const burnedFioDomains: string[] = [];

        while (lastBlock < maxBlockNum) {
            // Fetch transaction IDs for each block in range
            const response = await axios.post(`${apiUrl}/v1/history/get_block_txids`, {
                block_num: lastBlock + 1,
            });
            const actionIds = response.data.ids;

            if (actionIds && actionIds.length > 0) {
                // If block has transactions process each
                for (const actionId of actionIds) {
                    // Make the API call to get the transaction details
                    const transactionResponse = await axios.post(`${apiUrl}/v1/history/get_transaction`, {
                        id: actionId,
                    });
                    const traces = transactionResponse.data.traces;

                    for (const trace of traces) {
                        if (
                            trace.action_ordinal === 1 &&
                            trace.act.account === 'fio.address' &&
                            trace.act.name === 'regdomain'
                        ) {
                            registeredFioDomains.push(trace.act.data.fio_address);
                        } else if (trace.act.account === 'fio.address' && trace.act.name === 'burndomain') {
                            burnedFioDomains.push(trace.act.data.domainname);
                        }
                    }
                }
            } else {
                console.log('No transactions in block: ' + (lastBlock + 1));
            }

            lastBlock++;
        }

        // Send notifications to Discord webhook
        if (registeredFioDomains.length > 0) {
            const message = `The following FIO Domains were registered recently: ${registeredFioDomains.join(', ')}`;
            await axios.post(discordWebhookUrl, {content: message});
        }

        if (burnedFioDomains.length > 0) {
            const message = `The following FIO Domains were burned recently: ${burnedFioDomains.join(', ')}`;
            await axios.post(discordWebhookUrl, {content: message});
        }

        // Update data.json in S3 with the new last_block value
        jsonData.last_block = lastBlock;
        jsonData.active = false;
        await s3.putObject({
            Bucket: bucketName,
            Key: 'data.json',
            Body: JSON.stringify(jsonData),
        }).promise();

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Run complete.',
                last_block: lastBlock,
            }),
        };
    } catch (err) {
        console.log(err);

        if (bucketName) {
            // Set the active flag back to false in case of an error
            const params: AWS.S3.GetObjectRequest = {
                Bucket: bucketName,
                Key: 'data.json',
            };
            const data = await s3.getObject(params).promise();

            if (data.Body) {
                const jsonData = JSON.parse(data.Body.toString());
                jsonData.active = false;
                await s3.putObject({
                    Bucket: bucketName,
                    Key: 'data.json',
                    Body: JSON.stringify(jsonData),
                }).promise();
            }
        }

        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Error in function, aborting.',
                error: err instanceof Error ? err.message : 'Unknown error',
            }),
        };
    }
}