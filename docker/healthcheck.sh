#!/usr/bin/env bash
set -euo pipefail

curl -fsS --max-time 2 "http://127.0.0.1:${BACKEND_PORT:-8787}/healthz" >/dev/null
curl -fsS --max-time 2 "http://127.0.0.1:${AGENT_PORT:-8788}/healthz" >/dev/null
curl -fsS --max-time 2 "http://127.0.0.1:${WEB_PORT:-5173}/" >/dev/null
