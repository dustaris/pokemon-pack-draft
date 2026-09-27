# Pokédex Pack Draft

Browser Pokémon collecting RPG: rip packs (keep 1 of 5), level and evolve with candy, battle 117 trainers across 9 regions, plus a Daily Challenge, daily packs and a weekly check-in.

- `index.html`: the game (written for the Claude artifact wrapper)
- `dex.js`, `sprites.js`: copied from PokemonLeagueDraft (generated there by `build/make_data.py`)
- `evo.js`: evolution graph from `build/make_evo.py`
- `engine.js`: trainers, battles, Daily Challenge (no DOM; `node build/balance.js` checks the odds)
- `docs/`: the GitHub Pages site, rebuilt with `build/make_site.sh`

Unofficial fan game. Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc.
