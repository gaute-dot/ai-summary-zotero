#!/usr/bin/env bash
# Builds dist/ai-summary-zotero-<version>.xpi and dist/updates.json
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('plugin/manifest.json'))['version'])")
ID=$(python3 -c "import json;print(json.load(open('plugin/manifest.json'))['applications']['zotero']['id'])")
REPO="gaute-dot/ai-summary-zotero"
mkdir -p dist
XPI="dist/ai-summary-zotero-${VERSION}.xpi"
rm -f "$XPI"
(cd plugin && zip -qr "../$XPI" . -x '*.DS_Store')
cat > dist/updates.json <<JSON
{
  "addons": {
    "${ID}": {
      "updates": [
        {
          "version": "${VERSION}",
          "update_link": "https://github.com/${REPO}/releases/download/v${VERSION}/ai-summary-zotero-${VERSION}.xpi",
          "applications": { "zotero": { "strict_min_version": "6.999" } }
        }
      ]
    }
  }
}
JSON
echo "Built $XPI"
