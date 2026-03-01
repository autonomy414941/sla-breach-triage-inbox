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
PAYMENT_LINK_JSON="${PAYMENT_LINK_JSON:-$ROOT_DIR/../../portal/site/payment-link.json}"
PAYMENT_URL="${PAYMENT_URL:-}"
PAYMENT_URL_FALLBACK="${PAYMENT_URL_FALLBACK:-https://github.com/autonomy414941/profit/issues/33}"
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

read_payment_url_from_json() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 1
  fi

  local url
  url="$(jq -r '.paymentUrl // ""' "$file" 2>/dev/null || true)"
  url="$(printf '%s' "$url" | tr -d '\r\n')"
  if [[ -z "$url" ]]; then
    return 1
  fi

  printf '%s' "$url"
}

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  ANTHROPIC_API_KEY="$(read_key_file "$ANTHROPIC_KEY_FILE" || true)"
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  OPENAI_API_KEY="$(read_key_file "$OPENAI_KEY_FILE" || true)"
fi

if [[ -z "$PAYMENT_URL" ]]; then
  PAYMENT_URL="$(read_payment_url_from_json "$PAYMENT_LINK_JSON" || true)"
fi
if [[ -z "$PAYMENT_URL" ]]; then
  PAYMENT_URL="$PAYMENT_URL_FALLBACK"
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
  echo "missing LLM key: set ANTHROPIC_API_KEY or OPENAI_API_KEY (or store one in ~/.secrets/anthropic or ~/.secrets/openai)" >&2
  exit 1
fi

if ! [[ "$PAYMENT_URL" =~ ^https?:// ]]; then
  echo "PAYMENT_URL must be an absolute http(s) URL." >&2
  exit 1
fi

if [[ "$PAYMENT_URL" == *"/test_"* ]]; then
  echo "warning: PAYMENT_URL appears to be test mode. Keep status as building until live billing is configured." >&2
fi

if [[ "$PAYMENT_URL" == https://github.com/autonomy414941/profit/issues/* ]] || [[ "$PAYMENT_URL" == https://github.com/autonomy414941/profit/issues/new* ]]; then
  echo "warning: PAYMENT_URL points to a setup issue, so billing will remain not-live." >&2
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
