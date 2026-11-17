#!/usr/bin/env bash
docker stop docdemo-forgejo >/dev/null 2>&1 && echo "stopped" || echo "not running"
