// Pokédex Pack Draft engine: species data, trainers, battles and the Daily Challenge.
// Loaded after dex.js and evo.js. Has no DOM access, so build/balance.js can run it in Node.
(function (G) {
// ---------- Types ----------
const TYPE_COLORS = { Normal:"#9A9A6E", Fire:"#E0701F", Water:"#4B7BE0", Electric:"#D4A800", Grass:"#5FA83A", Ice:"#5EB8B4",
  Fighting:"#B42B25", Poison:"#8E3C92", Ground:"#C79B45", Flying:"#8C74DC", Psychic:"#E6446F", Bug:"#8C9A1A",
  Rock:"#A48B30", Ghost:"#6A5690", Dragon:"#5B2EE8", Dark:"#5E4D40", Steel:"#8E8EA8", Fairy:"#D8739A" };
const TYPES = Object.keys(TYPE_COLORS);
// attacker -> [super effective], [not very effective], [no effect]
const CHART = {
  Normal:   [[], ["Rock","Steel"], ["Ghost"]],
  Fire:     [["Grass","Ice","Bug","Steel"], ["Fire","Water","Rock","Dragon"], []],
  Water:    [["Fire","Ground","Rock"], ["Water","Grass","Dragon"], []],
  Electric: [["Water","Flying"], ["Electric","Grass","Dragon"], ["Ground"]],
  Grass:    [["Water","Ground","Rock"], ["Fire","Grass","Poison","Flying","Bug","Dragon","Steel"], []],
  Ice:      [["Grass","Ground","Flying","Dragon"], ["Fire","Water","Ice","Steel"], []],
  Fighting: [["Normal","Ice","Rock","Dark","Steel"], ["Poison","Flying","Psychic","Bug","Fairy"], ["Ghost"]],
  Poison:   [["Grass","Fairy"], ["Poison","Ground","Rock","Ghost"], ["Steel"]],
  Ground:   [["Fire","Electric","Poison","Rock","Steel"], ["Grass","Bug"], ["Flying"]],
  Flying:   [["Grass","Fighting","Bug"], ["Electric","Rock","Steel"], []],
  Psychic:  [["Fighting","Poison"], ["Psychic","Steel"], ["Dark"]],
  Bug:      [["Grass","Psychic","Dark"], ["Fire","Fighting","Poison","Flying","Ghost","Steel","Fairy"], []],
  Rock:     [["Fire","Ice","Flying","Bug"], ["Fighting","Ground","Steel"], []],
  Ghost:    [["Psychic","Ghost"], ["Dark"], ["Normal"]],
  Dragon:   [["Dragon"], ["Steel"], ["Fairy"]],
  Dark:     [["Psychic","Ghost"], ["Fighting","Dark","Fairy"], []],
  Steel:    [["Ice","Rock","Fairy"], ["Fire","Water","Electric","Steel"], []],
  Fairy:    [["Fighting","Dragon","Dark"], ["Fire","Poison","Steel"], []],
};
function eff(atk, def) {
  const [se, nve, imm] = CHART[atk];
  return imm.includes(def) ? 0 : se.includes(def) ? 2 : nve.includes(def) ? .5 : 1;
}
const mult = (atk, types) => types.reduce((m, d) => m * eff(atk, d), 1);
// [physical, special] signature move per type
const MOVES = { Normal:["Body Slam","Hyper Voice"], Fire:["Fire Punch","Flamethrower"], Water:["Waterfall","Surf"],
  Electric:["Thunder Punch","Thunderbolt"], Grass:["Leaf Blade","Energy Ball"], Ice:["Ice Punch","Ice Beam"],
  Fighting:["Close Combat","Aura Sphere"], Poison:["Poison Jab","Sludge Bomb"], Ground:["Earthquake","Earth Power"],
  Flying:["Drill Peck","Air Slash"], Psychic:["Zen Headbutt","Psychic"], Bug:["X-Scissor","Bug Buzz"],
  Rock:["Rock Slide","Power Gem"], Ghost:["Shadow Claw","Shadow Ball"], Dragon:["Dragon Claw","Dragon Pulse"],
  Dark:["Crunch","Dark Pulse"], Steel:["Iron Head","Flash Cannon"], Fairy:["Play Rough","Moonblast"] };

// ---------- Species ----------
const DEX = G.DEX.map(([num, name, types, stats, legend]) => {
  const bst = stats.reduce((a, b) => a + b, 0);
  return { num, name, types, stats, bst, legend: !!legend, tier: legend ? 3 : bst >= 500 ? 2 : bst >= 400 ? 1 : 0 };
});
const byNum = n => DEX[n - 1];
const EVO = G.EVO || {}, FAM = G.FAM || [];
const family = n => FAM[n - 1] || n;
const PREV = {};
for (const k in EVO) for (const [to, lvl, depth] of EVO[k]) PREV[to] = { from: +k, lvl, depth };
const obtainLvl = n => PREV[n] ? PREV[n].lvl : 1;
const firstEvoLvl = n => EVO[n] ? Math.min(...EVO[n].map(e => e[1])) : Infinity;
const evosOf = n => (EVO[n] || []).map(([to, lvl, depth]) => ({ to, lvl, cost: depth >= 2 ? 25 : 10 }));
const powerCost = lvl => 1 + Math.floor(lvl / 20);   // family candy per level
const xpNeed = lvl => 5 * lvl + 15;                    // XP from lvl to lvl+1
const TRANSFER = [1, 1, 2, 4];                         // Rare Candy for releasing a Pokémon, by rarity tier

// ---------- RNG ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function draw(pool, rng) { return pool.splice(Math.floor(rng() * pool.length), 1)[0]; }

// ---------- Regions and the League journey ----------
const REGIONS = [
  { id: "kanto",  name: "Kanto",  gen: "I",    lo: 1,   hi: 151,  color: "#D23A35", mascot: 150,
    gyms: [["Brock","Rock"],["Misty","Water"],["Lt. Surge","Electric"],["Erika","Grass"],["Koga","Poison"],["Sabrina","Psychic"],["Blaine","Fire"],["Giovanni","Ground"]],
    e4: [["Lorelei","Ice"],["Bruno","Fighting"],["Agatha","Ghost"],["Lance","Dragon"]], champ: "Blue" },
  { id: "johto",  name: "Johto",  gen: "II",   lo: 152, hi: 251,  color: "#B98A1E", mascot: 250,
    gyms: [["Falkner","Flying"],["Bugsy","Bug"],["Whitney","Normal"],["Morty","Ghost"],["Chuck","Fighting"],["Jasmine","Steel"],["Pryce","Ice"],["Clair","Dragon"]],
    e4: [["Will","Psychic"],["Koga","Poison"],["Bruno","Fighting"],["Karen","Dark"]], champ: "Lance" },
  { id: "hoenn",  name: "Hoenn",  gen: "III",  lo: 252, hi: 386,  color: "#23906A", mascot: 384,
    gyms: [["Roxanne","Rock"],["Brawly","Fighting"],["Wattson","Electric"],["Flannery","Fire"],["Norman","Normal"],["Winona","Flying"],["Tate & Liza","Psychic"],["Juan","Water"]],
    e4: [["Sidney","Dark"],["Phoebe","Ghost"],["Glacia","Ice"],["Drake","Dragon"]], champ: "Steven" },
  { id: "sinnoh", name: "Sinnoh", gen: "IV",   lo: 387, hi: 493,  color: "#4553BE", mascot: 483,
    gyms: [["Roark","Rock"],["Gardenia","Grass"],["Maylene","Fighting"],["Crasher Wake","Water"],["Fantina","Ghost"],["Byron","Steel"],["Candice","Ice"],["Volkner","Electric"]],
    e4: [["Aaron","Bug"],["Bertha","Ground"],["Flint","Fire"],["Lucian","Psychic"]], champ: "Cynthia" },
  { id: "unova",  name: "Unova",  gen: "V",    lo: 494, hi: 649,  color: "#33363F", mascot: 643,
    gyms: [["Cilan","Grass"],["Lenora","Normal"],["Burgh","Bug"],["Elesa","Electric"],["Clay","Ground"],["Skyla","Flying"],["Brycen","Ice"],["Drayden","Dragon"]],
    e4: [["Shauntal","Ghost"],["Grimsley","Dark"],["Caitlin","Psychic"],["Marshal","Fighting"]], champ: "Alder" },
  { id: "kalos",  name: "Kalos",  gen: "VI",   lo: 650, hi: 721,  color: "#2A78AE", mascot: 716,
    gyms: [["Viola","Bug"],["Grant","Rock"],["Korrina","Fighting"],["Ramos","Grass"],["Clemont","Electric"],["Valerie","Fairy"],["Olympia","Psychic"],["Wulfric","Ice"]],
    e4: [["Malva","Fire"],["Siebold","Water"],["Wikstrom","Steel"],["Drasna","Dragon"]], champ: "Diantha" },
  { id: "alola",  name: "Alola",  gen: "VII",  lo: 722, hi: 809,  color: "#D8752E", mascot: 791,
    gyms: [["Ilima","Normal"],["Lana","Water"],["Kiawe","Fire"],["Mallow","Grass"],["Sophocles","Electric"],["Acerola","Ghost"],["Mina","Fairy"],["Nanu","Dark"]],
    e4: [["Hala","Fighting"],["Olivia","Rock"],["Kahili","Flying"],["Molayne","Steel"]], champ: "Kukui" },
  { id: "galar",  name: "Galar",  gen: "VIII", lo: 810, hi: 905,  color: "#A8336B", mascot: 888,
    gyms: [["Milo","Grass"],["Nessa","Water"],["Kabu","Fire"],["Bea","Fighting"],["Opal","Fairy"],["Gordie","Rock"],["Piers","Dark"],["Raihan","Dragon"]],
    e4: [["Klara","Poison"],["Avery","Psychic"],["Marnie","Dark"],["Hop",null]], champ: "Leon" },
  { id: "paldea", name: "Paldea", gen: "IX",   lo: 906, hi: 1025, color: "#7038A8", mascot: 1007,
    gyms: [["Katy","Bug"],["Brassius","Grass"],["Iono","Electric"],["Kofu","Water"],["Larry","Normal"],["Ryme","Ghost"],["Tulip","Psychic"],["Grusha","Ice"]],
    e4: [["Rika","Ground"],["Poppy","Steel"],["Larry","Flying"],["Hassel","Dragon"]], champ: "Geeta" },
];
const E4_TITLE = { galar: "Champion Cup" };
const TRAINERS = [];
REGIONS.forEach((r, ri) => {
  r.gyms.forEach(([name, type], k) => TRAINERS.push({ name, type, kind: "gym", title: `Gym ${k + 1}`, ri, k }));
  r.e4.forEach(([name, type], k) => TRAINERS.push({ name, type, kind: "e4", title: `${E4_TITLE[r.id] || "Elite Four"} ${k + 1}`, ri, k: 8 + k }));
  TRAINERS.push({ name: r.champ, type: null, kind: "champ", title: "Champion", ri, k: 12 });
});
const LAST = TRAINERS.length - 1;
TRAINERS.forEach((t, i) => {
  t.idx = i;
  t.region = REGIONS[t.ri];
  t.level = Math.min(96, Math.round(6 + 86 * Math.pow(i / LAST, .75)) + (t.kind === "champ" ? 4 : t.kind === "e4" ? 2 : 0));
  t.size = t.kind === "champ" ? 6 : t.kind === "e4" ? Math.min(6, 4 + t.ri) : Math.min(6, 2 + Math.floor(t.k / 3) + t.ri);
  t.reward = t.kind === "champ" ? { packs: 5, rare: 3 } : { packs: 2, rare: 0 };
});

// A species "fits" a level when it could plausibly be that far along its evolution line.
const fitsLevel = (m, L) => !m.legend && obtainLvl(m.num) <= L + 3 && firstEvoLvl(m.num) + 5 > L;

function trainerTeam(t) {
  if (t.team) return t.team;
  const rng = mulberry32(hashStr("trainer-" + t.idx));
  const R = t.region, L = t.level;
  const typed = m => !t.type || m.types.includes(t.type);
  const inR = m => m.num >= R.lo && m.num <= R.hi;
  const tries = [m => inR(m) && typed(m) && fitsLevel(m, L), m => typed(m) && fitsLevel(m, L), m => typed(m) && !m.legend, m => fitsLevel(m, L)];
  const picks = [], seen = new Set();
  for (const f of tries) {
    if (picks.length >= t.size) break;
    let pool = DEX.filter(m => f(m) && !seen.has(m.num));
    // Gyms draw from their stronger picks; the Elite Four and Champions from their very best
    pool = pool.sort((a, b) => b.bst - a.bst).slice(0, Math.max(t.size * (t.kind === "gym" ? 3 : 2), 8));
    while (picks.length < t.size && pool.length) { const m = draw(pool, rng); picks.push(m.num); seen.add(m.num); }
  }
  picks.sort((a, b) => byNum(a).bst - byNum(b).bst); // ace last
  t.team = picks.map((num, i) => ({ num, lvl: Math.min(100, i === picks.length - 1 ? L + 2 : L - Math.floor(rng() * 3)) }));
  return t.team;
}

// ---------- Battles ----------
function makeBattler({ num, lvl, shiny }) {
  const m = byNum(num), s = m.stats;
  const st = i => Math.floor(2 * s[i] * lvl / 100) + 5;
  const hp = Math.floor(2 * s[0] * lvl / 100) + lvl + 10;
  return { num, name: m.name, types: m.types, lvl, shiny: !!shiny, maxhp: hp, hp, atk: st(1), def: st(2), spa: st(3), spd: st(4), spe: st(5) };
}
function chooseMove(a, d) {
  const phys = a.atk >= a.spa;
  let best = null;
  for (const type of a.types) {
    const mul = mult(type, d.types);
    if (!best || mul > best.mul) best = { type, mul, phys, name: MOVES[type][phys ? 0 : 1], pow: 70, stab: 1.5 };
  }
  if (best.mul === 0) best = { type: null, mul: 1, phys, name: "Struggle", pow: 40, stab: 1 };
  return best;
}
// Plays a full battle. Sides are arrays of { num, lvl, shiny }. With log on, returns the event list the UI animates.
function battle(sideA, sideB, rng = Math.random, log = true) {
  const A = sideA.map(makeBattler), B = sideB.map(makeBattler), T = [A, B], at = [0, 0];
  const ev = log ? [{ t: "send", side: 0, i: 0 }, { t: "send", side: 1, i: 0 }] : null;
  for (let turn = 0; turn < 600 && at[0] < A.length && at[1] < B.length; turn++) {
    const a = A[at[0]], b = B[at[1]];
    const aFirst = a.spe > b.spe || (a.spe === b.spe && rng() < .5);
    for (const side of aFirst ? [0, 1] : [1, 0]) {
      const att = T[side][at[side]], def = T[1 - side][at[1 - side]];
      const mv = chooseMove(att, def);
      const A_ = mv.phys ? att.atk : att.spa, D_ = mv.phys ? def.def : def.spd;
      const crit = rng() < 1 / 24;
      const dmg = Math.max(1, Math.floor(((2 * att.lvl / 5 + 2) * mv.pow * A_ / D_ / 50 + 2) * mv.stab * mv.mul * (crit ? 1.5 : 1) * (.85 + rng() * .15)));
      def.hp = Math.max(0, def.hp - dmg);
      if (log) ev.push({ t: "hit", side, move: mv.name, type: mv.type, mul: mv.mul, crit, dmg, hp: def.hp });
      if (def.hp === 0) {
        const fs = 1 - side;
        at[fs]++;
        if (log) { ev.push({ t: "faint", side: fs }); if (at[fs] < T[fs].length) ev.push({ t: "send", side: fs, i: at[fs] }); }
        break;
      }
    }
  }
  const win = at[1] >= B.length;
  return { win, ev, A, B, used: Math.min(at[0] + 1, A.length), kos: at[1] };
}
function winChance(sideA, sideB, n = 150) {
  let w = 0;
  for (let i = 0; i < n; i++) if (battle(sideA, sideB, Math.random, false).win) w++;
  return w / n;
}

// ---------- Daily Challenge ----------
const DAY0 = Date.UTC(2026, 8, 27);
const dayNumber = date => { const [y, m, d] = date.split("-").map(Number); return Math.round((Date.UTC(y, m - 1, d) - DAY0) / 864e5) + 1; };
const finalForm = m => !EVO[m.num];
function dailyChallenge(date) {
  const rng = mulberry32(hashStr("daily-" + date));
  const kinds = ["type", "type", "region", "nolegend", "budget"];
  const kind = kinds[Math.floor(rng() * kinds.length)];
  let rule;
  if (kind === "type") { const type = TYPES[Math.floor(rng() * TYPES.length)]; rule = { kind, type, label: `${type} types only`, ok: m => m.types.includes(type) }; }
  else if (kind === "region") { const R = REGIONS[Math.floor(rng() * REGIONS.length)]; rule = { kind, label: `${R.name} Pokémon only`, ok: m => m.num >= R.lo && m.num <= R.hi }; }
  else if (kind === "nolegend") rule = { kind, label: "No Legendaries", ok: m => !m.legend };
  else rule = { kind, label: "Base stat total under 500", ok: m => m.bst < 500 };
  const boss = TRAINERS[Math.floor(rng() * TRAINERS.length)];
  const bossOk = m => !m.legend && finalForm(m) && (rule.kind === "type" || rule.ok(m)) && (!boss.type || m.types.includes(boss.type));
  let pool = DEX.filter(m => bossOk(m) && m.bst >= 430 && m.bst <= 540);
  if (pool.length < 6) pool = DEX.filter(m => !m.legend && finalForm(m) && (rule.kind === "type" || rule.ok(m)) && m.bst >= 430 && m.bst <= 540);
  const team = [];
  while (team.length < 6 && pool.length) team.push(draw(pool, rng).num);
  team.sort((a, b) => byNum(a).bst - byNum(b).bst);
  let rp = DEX.filter(m => rule.ok(m) && !m.legend && m.bst >= 440 && m.bst <= 510);
  if (rp.length < 6) rp = DEX.filter(m => rule.ok(m) && !m.legend).sort((a, b) => b.bst - a.bst).slice(0, 12);
  const rentals = [];
  while (rentals.length < 6 && rp.length) rentals.push(draw(rp, rng).num);
  return { date, n: dayNumber(date), rule, boss: { name: boss.name, title: boss.title, region: boss.region.name, type: boss.type },
           team: team.map(num => ({ num, lvl: 50 })), rentals };
}
// Scored out of 100: half for knockouts, half for HP left standing when you win.
function challengeScore(res) {
  if (!res.win) return Math.round(res.kos / res.B.length * 50);
  const left = res.A.reduce((s, b) => s + b.hp, 0) / res.A.reduce((s, b) => s + b.maxhp, 0);
  return 50 + Math.round(left * 50);
}

G.ENGINE = { TYPE_COLORS, TYPES, eff, mult, MOVES, DEX, byNum, family, evosOf, PREV, obtainLvl, powerCost, xpNeed, TRANSFER,
  REGIONS, TRAINERS, trainerTeam, battle, winChance, makeBattler, mulberry32, hashStr, dailyChallenge, dayNumber, challengeScore };
})(typeof window !== "undefined" ? window : globalThis);
