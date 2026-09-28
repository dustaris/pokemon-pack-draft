#!/bin/sh
# Builds the standalone GitHub Pages copy in docs/ from index.html (which is written for the Claude artifact wrapper).
set -e
cd "$(dirname "$0")/.."
mkdir -p docs
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  printf '<meta name="description" content="Rip free Pokémon packs every day, keep one card from each and fill all 1,025 Pokédex entries. WD Card Shop members can find discount codes and store credit in packs. An unofficial fan game.">\n'
  printf '<style>html{color-scheme:light}body{margin:0}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
  cat index.html
  printf '\n</body>\n</html>\n'
} > docs/index.html
cp dex.js sprites.js evo.js engine.js rules.html docs/
# Cache-bust the scripts with this build's time so a new deploy never mixes with old cached files
v=$(date +%Y%m%d%H%M)
sed -i '' -E "s/src=\"(dex|sprites|evo|engine)\.js\"/src=\"\1.js?v=$v\"/g" docs/index.html
touch docs/.nojekyll
