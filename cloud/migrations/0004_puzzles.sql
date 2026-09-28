-- Daily Puzzles, generated ahead of time by cloud/puzzles.js. boss_order is secret until the day is over.
CREATE TABLE IF NOT EXISTS puzzles (
  day TEXT PRIMARY KEY, n INTEGER NOT NULL, label TEXT NOT NULL,
  boss_name TEXT NOT NULL, boss_title TEXT NOT NULL, boss_region TEXT NOT NULL,
  roster TEXT NOT NULL,       -- JSON [6 dex numbers], shown to everyone
  boss_set TEXT NOT NULL,     -- JSON [6 dex numbers] sorted, shown to everyone
  boss_order TEXT NOT NULL,   -- JSON [6 dex numbers] in battle order: SECRET
  best_raw INTEGER NOT NULL, best_count INTEGER NOT NULL, win_frac REAL NOT NULL
);
-- Every ranked try, for review and to show players their earlier orders
CREATE TABLE IF NOT EXISTS attempts (
  day TEXT NOT NULL, cid TEXT NOT NULL, try INTEGER NOT NULL,
  lineup TEXT NOT NULL, raw INTEGER NOT NULL, score INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (day, cid, try)
);
