-- Collection-first rewards: score per player, month-start baseline for monthly gains, active days, public showcases
CREATE TABLE IF NOT EXISTS collection (
  cid TEXT PRIMARY KEY,
  name TEXT,                 -- trainer name shown on boards and in the gallery
  score INTEGER NOT NULL DEFAULT 0,
  shinies INTEGER NOT NULL DEFAULT 0,
  caught INTEGER NOT NULL DEFAULT 0,
  updated TEXT,
  showcase TEXT,             -- JSON [{num, shiny, grade}] up to 6, validated against the saved collection
  showcase_at TEXT
);
CREATE TABLE IF NOT EXISTS month_start (cid TEXT NOT NULL, month TEXT NOT NULL, start INTEGER NOT NULL, PRIMARY KEY (cid, month));
CREATE TABLE IF NOT EXISTS active_days (cid TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (cid, day));
