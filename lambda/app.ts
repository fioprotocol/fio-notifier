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
        console.log(`Current last_block: ${jsonData.last_block}`);

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
        let updated = false;

        try {
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

            // Check if last_indexed_block is valid and higher than our current block
            if (typeof response.data.last_indexed_block === 'number' &&
                !isNaN(response.data.last_indexed_block) &&
                response.data.last_indexed_block >= lastBlock - 1) {

                jsonData.last_block = response.data.last_indexed_block;
                updated = true;

                // Look for registrations and burns
                const registeredFioDomains: { [key: string]: boolean } = {};
                const burnedFioDomains: { [key: string]: boolean } = {};

                for (const delta of response.data.deltas) {
                    if (delta.present === 1) {
                        registeredFioDomains[delta.data.name] = true;
                    } else if (delta.present === 0) {
                        burnedFioDomains[delta.data.name] = true;
                    }
                }

                // Send notifications to Discord webhook
                if (Object.keys(burnedFioDomains).length > 0) {
                    const message = `The following FIO Domains were recently burned: ${Object.keys(burnedFioDomains).join(', ')}`;
                    await axios.post(discordWebhookUrl, { content: message });
                }

                if (Object.keys(registeredFioDomains).length > 0) {
                    const message = `The following FIO Domains were recently registered/renewed/transferred/wrapped: ${Object.keys(registeredFioDomains).join(', ')}`;
                    await axios.post(discordWebhookUrl, { content: message });
                }
            } else {
                console.log(`Invalid or not-higher last_indexed_block: ${response.data.last_indexed_block}, current: ${jsonData.last_block}`);
            }
        } catch (apiError) {
            console.log('Error during API processing:', apiError);
            console.log('Not updating last_block due to error');
        }

        // Always reset active flag before saving
        jsonData.active = false;
        await s3.putObject({
            Bucket: bucketName,
            Key: 'data.json',
            Body: JSON.stringify(jsonData),
        }).promise();

        console.log('Processing completed. last_block is now: ' + jsonData.last_block + (updated ? ' (updated)' : ' (unchanged)'));

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Run complete.',
                last_block: lastBlock,
                updated: updated
            }),
        };
    } catch (err) {
        console.log(err);

        if (bucketName) {
            try {
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
            } catch (s3Error) {
                console.log('Error resetting active flag:', s3Error);
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