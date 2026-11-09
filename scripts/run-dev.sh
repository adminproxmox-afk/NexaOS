#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname "$0")/.."
exec python3 -m http.server "${1:-8000}" --bind 127.0.0.1
