# Builds evo.js (evolution graph) from Showdown's pokedex.json (kept in ../PokemonLeagueDraft/build).
import json, os
src = os.path.join(os.path.dirname(__file__), '../../PokemonLeagueDraft/build/pokedex.json')
d = json.load(open(src))
base = {v['name']: v for v in d.values() if 'baseStats' in v and not v.get('forme') and 1 <= v.get('num', 0) <= 1025}
num = {n: v['num'] for n, v in base.items()}
def depth(v):
    k = 0
    while v.get('prevo') in base: v = base[v['prevo']]; k += 1
    return k
evo, fam = {}, {}
for n, v in base.items():
    r = v
    while r.get('prevo') in base: r = base[r['prevo']]
    fam[v['num']] = r['num']
    outs = []
    for e in v.get('evos', []):
        if e not in base: continue  # regional formes, e.g. Raichu-Alola
        t = base[e]
        lvl = t.get('evoLevel') or (36 if depth(t) >= 2 else 20)
        outs.append([t['num'], lvl, depth(t)])
    if outs: evo[v['num']] = outs
root = [fam[i] for i in range(1, 1026)]
open(os.path.join(os.path.dirname(__file__), '../evo.js'), 'w').write(
    'window.EVO=' + json.dumps(evo, separators=(',', ':')) + ';window.FAM=' + json.dumps(root, separators=(',', ':')) + ';')
print(len(evo), 'species can evolve;', len(set(root)), 'families')
