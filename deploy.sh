#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="sla-breach-triage-inbox:latest"
CONTAINER_NAME="sla-breach-triage-inbox"
TRAEFIK_DYNAMIC_DIR="/data/coolify/proxy/dynamic"
PERSIST_DIR="$ROOT_DIR/../../data/sla-breach-triage-inbox"
ANTHROPIC_KEY_FILE="${ANTHROPIC_KEY_FILE:-$HOME/.secrets/anthropic}"
OPENAI_KEY_FILE="${OPENAI_KEY_FILE:-$HOME/.secrets/openai}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://sla-breach-triage.devtoolbox.dedyn.io}"
PAYMENT_URL="${PAYMENT_URL:-https://buy.stripe.com/test_eVq6oH8mqf5WeQJ2jQ}"
PRICE_USD="${PRICE_USD:-9}"

read_key_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 1
  fi

  local line
  line="$(grep -E '^[[:space:]]*[^#[:space:]]' "$file" | head -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi

  line="${line#export }"
  if [[ "$line" == *=* ]]; then
    line="${line#*=}"
  fi

  line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  line="$(printf '%s' "$line" | tr -d '\r\n')"

  if [[ -z "$line" ]]; then
    return 1
  fi

  printf '%s' "$line"
}

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  ANTHROPIC_API_KEY="$(read_key_file "$ANTHROPIC_KEY_FILE" || true)"
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  OPENAI_API_KEY="$(read_key_file "$OPENAI_KEY_FILE" || true)"
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
  echo "missing LLM key: set ANTHROPIC_API_KEY or OPENAI_API_KEY (or store one in ~/.secrets/anthropic or ~/.secrets/openai)" >&2
  exit 1
fi

if [[ "$PAYMENT_URL" != https://buy.stripe.com/* ]]; then
  echo "PAYMENT_URL must be a Stripe checkout link (https://buy.stripe.com/...)" >&2
  exit 1
fi

if [[ "$PAYMENT_URL" == *"/test_"* ]]; then
  echo "warning: PAYMENT_URL is Stripe test mode. Keep status as building until live payment link is configured." >&2
fi

cd "$ROOT_DIR"

docker build -t "$IMAGE_NAME" .

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
mkdir -p "$PERSIST_DIR"

docker_env=(
  -e DATA_DIR=/data
  -e PUBLIC_BASE_URL="$PUBLIC_BASE_URL"
  -e PAYMENT_URL="$PAYMENT_URL"
  -e PRICE_USD="$PRICE_USD"
  -e TRIAL_DAYS="14"
)

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  docker_env+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
fi

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  docker_env+=(-e "OPENAI_API_KEY=$OPENAI_API_KEY")
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network coolify \
  "${docker_env[@]}" \
  -v "$PERSIST_DIR:/data" \
  "$IMAGE_NAME" >/dev/null

cp "$ROOT_DIR/infra/sla-breach-triage-inbox.traefik.yaml" "$TRAEFIK_DYNAMIC_DIR/sla-breach-triage-inbox.yaml"

echo "Deployed: $PUBLIC_BASE_URL"
