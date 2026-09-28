// Journey difficulty with card grades (no levels): node build/balance_grades.js [gradeCurve]
globalThis.window = globalThis;
require("../dex.js"); require("../evo.js"); require("../engine.js");
const E = globalThis.ENGINE, { DEX, byNum, TRAINERS, trainerTeam, winChance, addCopy, GRADES } = E;
if (process.argv[2]) E.setGradeCurve(+process.argv[2]);
const rnd = a => a[Math.floor(Math.random() * a.length)];
function pack(lo, hi) {
  const pool = DEX.slice(lo - 1, hi), r = Math.random(), hit = r < .05 ? 3 : r < .3 ? 2 : 1;
  return [0, 0, 0, 1, hit].map(t => rnd(pool.filter(m => m.tier === t).length ? pool.filter(m => m.tier === t) : pool));
}
// A player reaching trainer idx: ~3.5 packs per trainer (journey + dailies), mostly that region's packs; keeps the strongest card
function player(idx) {
  const box = {}; let rare = Math.floor(idx / 2) + 3 * Math.floor(idx / 13);
  const packs = 6 + Math.round(3.5 * idx);
  for (let i = 0; i < packs; i++) {
    const R = i < 6 ? { lo: 1, hi: 1025 } : TRAINERS[Math.min(idx, Math.floor((i - 6) / 3.5))].region;
    const k = pack(R.lo, R.hi).sort((a, b) => b.bst - a.bst)[0];
    if (box[k.num]) addCopy(box[k.num]); else box[k.num] = { grade: 0, dupes: 0 };
  }
  const top = Object.keys(box).map(Number).sort((a, b) => byNum(b).bst * E.GRADE_BOOST[box[b].grade] - byNum(a).bst * E.GRADE_BOOST[box[a].grade]).slice(0, 6);
  for (; rare > 0; rare--) addCopy(box[top[rare % top.length]]);
  return top.map(num => ({ num, lvl: 50, grade: box[num].grade }));
}
console.log("idx  trainer              grade size |  win% (avg of 8 players) | player grades");
for (const t of TRAINERS) {
  if (t.k % 4 !== 0 && t.kind !== "champ") continue;
  let s = 0, g = [];
  for (let i = 0; i < 8; i++) { const p = player(t.idx); s += winChance(p, trainerTeam(t), 40); g.push(p.reduce((a, b) => a + b.grade, 0)); }
  console.log(String(t.idx).padStart(3), (t.region.name + " " + t.name).padEnd(20), GRADES[t.grade].padEnd(5), String(t.size).padStart(4), " |", String(Math.round(s / 8 * 100)).padStart(4) + "%", "                  | avg grade sum", (g.reduce((a, b) => a + b, 0) / g.length).toFixed(1));
}
