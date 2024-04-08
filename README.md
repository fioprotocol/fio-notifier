# fio-notifier

## Overview
This is an AWS Lambda function that monitors every block from FIO History to look for domain registrations and burns and if it finds it, it notifies Discord webhook.

It uses S3 to store the last block checked. It will check all blocks since last checked till last irreversible, but no more than MAX_BLOCKS_PER_RUN in a single run.

## Environment variables
|var|description|
|---|---|
|API_URL|FIO API running V1 History|
|DISCORD_WEBHOOK_URL|Discord Webhook Url|
|MAX_BLOCKS_PER_RUN|See above|
|S3_BUCKET_NAME|Name of S3 bucket to store last_block|
