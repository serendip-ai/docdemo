#!/usr/bin/env bash
# Stop (and, because it runs with --rm, remove) the benchmark Mattermost container.
docker rm -fv docdemo-mattermost >/dev/null 2>&1 && echo "stopped" || echo "not running"
