#!/usr/bin/env bash
# Build the OpenAI plugin submission ZIP (plugin.json at the ZIP root).
# Output: ../dist-openai/sendseven-plugin-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c 'import json;print(json.load(open("plugin.json"))["version"])')
OUT_DIR="$(cd .. && pwd)/dist-openai"
OUT="$OUT_DIR/sendseven-plugin-$VERSION.zip"
mkdir -p "$OUT_DIR"
rm -f "$OUT"
# Only ship the plugin payload (no scripts, no stray files).
zip -r -X -D "$OUT" plugin.json mcp.json skills assets -x '*.DS_Store'
echo "Built $OUT"
unzip -l "$OUT"
