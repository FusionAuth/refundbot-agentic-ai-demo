#!/usr/bin/env bash
set -euo pipefail

REGION=us-east-2
PROFILE=fusionauth-sandbox
REGISTRY=011271748719.dkr.ecr.us-east-2.amazonaws.com
IMAGE=refundbot-agent

docker buildx build --platform linux/arm64 -t "$IMAGE" ./agent --load

aws ecr get-login-password --region "$REGION" --profile "$PROFILE" | docker login --username AWS --password-stdin "$REGISTRY"

docker tag "$IMAGE:latest" "$REGISTRY/$IMAGE:latest"

docker push "$REGISTRY/$IMAGE:latest"
