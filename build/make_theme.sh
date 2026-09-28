#!/bin/sh
# Fills the shared secret into the Shopify page template (output is gitignored), ready for:
#   cd cloud/theme-out && shopify theme push --store 1marss-2m --theme <live theme id> --only templates/page.pokedex.liquid --allow-live
set -e
cd "$(dirname "$0")/.."
mkdir -p cloud/theme-out/templates
python3 - <<'PY'
s = open('shopify/templates/page.pokedex.liquid').read()
secret = open('cloud/secret.txt').read().strip()
assert len(secret) == 64
open('cloud/theme-out/templates/page.pokedex.liquid', 'w').write(s.replace('__PD_SECRET__', secret))
PY
echo "Wrote cloud/theme-out/templates/page.pokedex.liquid"
