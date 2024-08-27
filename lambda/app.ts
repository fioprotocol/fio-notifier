import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as AWS from 'aws-sdk';
import axios from 'axios';
const s3 = new AWS.S3();
const bucketName = process.env.S3_BUCKET_NAME;
const apiUrl = process.env.API_URL;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

interface Delta {
    timestamp: string;
    present: number;
    code: string;
    scope: string;
    table: string;
    primary_key: string;
    payer: string;
    block_num: number;
    block_id: string;
    data: {
        id: string;
        name: string;
        domainhash: string;
        account: string;
        is_public: number;
        expiration: string;
    };
}

interface DeltaResponse {
    query_time_ms: number;
    last_indexed_block: number;
    last_indexed_block_time: string;
    total: {
        value: number;
        relation: string;
    };
    deltas: Delta[];
}

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!bucketName || !apiUrl || !discordWebhookUrl) {
            throw new Error('Required environment variables are not set');
        }

        // Read data.json from S3
        const params: AWS.S3.GetObjectRequest = {
            Bucket: bucketName,
            Key: 'data.json',
        };
        const data = await s3.getObject(params).promise();

        if (!data.Body) {
            throw new Error('Empty data received from S3');
        }
        const jsonData = JSON.parse(data.Body.toString());

        console.log(`S3 active flag: ${jsonData.active}`);

        if (jsonData.active) {
            console.log('Lambda function still running, exiting.');
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Lambda function still running, exiting.',
                }),
            };
        }

        // Set the active flag to true
        jsonData.active = true;
        await s3.putObject({
            Bucket: bucketName,
            Key: 'data.json',
            Body: JSON.stringify(jsonData),
        }).promise();

        let lastBlock = jsonData.last_block + 1;
        console.log('Starting processing at block ' + lastBlock);

        // Get domains table deltas
        const response = await axios.get<DeltaResponse>(`${apiUrl}/v2/history/get_deltas`, {
            params: {
                code: 'fio.address',
                scope: 'fio.address',
                table: 'domains',
                sort: 'asc',
                after: lastBlock
            }
        });

        // Look for registrations and burns
        const registeredFioDomains: { [key: string]: boolean } = {};
        const burnedFioDomains: { [key: string]: boolean } = {};

        for (const delta of response.data.deltas) {
            if (delta.present === 1) {
                registeredFioDomains[delta.data.name] = true;
            } else if (delta.present === 0) {
                burnedFioDomains[delta.data.name] = true;
            }

            lastBlock = Math.max(lastBlock, delta.block_num);
        }

        // If no new deltas were found, update lastBlock to last_indexed_block
        if (response.data.deltas.length === 0) {
            lastBlock = response.data.last_indexed_block;
        }

        // Send notifications to Discord webhook
        if (Object.keys(burnedFioDomains).length > 0) {
            const message = `The following FIO Domains were recently burned: ${Object.keys(burnedFioDomains).join(', ')}`;
            await axios.post(discordWebhookUrl, { content: message });
        }

        if (Object.keys(registeredFioDomains).length > 0) {
            const message = `The following FIO Domains were recently registered/renewed: ${Object.keys(registeredFioDomains).join(', ')}`;
            await axios.post(discordWebhookUrl, { content: message });
        }

        // Update data.json in S3 with the new last_block value
        jsonData.last_block = lastBlock;
        jsonData.active = false;
        await s3.putObject({
            Bucket: bucketName,
            Key: 'data.json',
            Body: JSON.stringify(jsonData),
        }).promise();

        console.log('Processing completed at block ' + lastBlock);

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
};