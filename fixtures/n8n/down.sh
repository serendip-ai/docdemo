#!/usr/bin/env bash
# Stop the throwaway n8n container (started with --rm, so this also removes it).
set -euo pipefail
docker rm -f docdemo-n8n >/dev/null 2>&1 || true
echo "docdemo-n8n stopped"
