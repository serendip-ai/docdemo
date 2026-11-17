#!/usr/bin/env bash
set -euo pipefail
docker rm -f docdemo-metabase >/dev/null 2>&1 || true
echo "docdemo-metabase stopped"
