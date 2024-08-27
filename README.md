# fio-notifier

## Overview
This is an AWS Lambda function that looks for deltas in domain table for domain registrations and burns and if it finds it, it notifies Discord webhook.

It uses S3 to store the last block checked.

It requires Hyperion.

## Environment variables
|var|description|
|---|---|
|API_URL|FIO API running V1 History|
|DISCORD_WEBHOOK_URL|Discord Webhook Url|
|S3_BUCKET_NAME|Name of S3 bucket to store last_block|
