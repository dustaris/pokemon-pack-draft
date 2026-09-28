-- Players: first time we saw the account, rules/eligibility attestation, moderation state
CREATE TABLE IF NOT EXISTS players (
  cid TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  eligible_at TEXT,                         -- when they confirmed 18+ / US resident / Official Rules
  banned INTEGER NOT NULL DEFAULT 0,
  open_flags INTEGER NOT NULL DEFAULT 0,    -- anti-cheat flags not yet reviewed
  note TEXT
);
INSERT OR IGNORE INTO players (cid, first_seen) SELECT cid, updated FROM saves;

-- Anti-cheat: a snapshot of key numbers on every accepted save, with any plausibility flags
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cid TEXT NOT NULL, at TEXT NOT NULL, rev INTEGER,
  dex_n INTEGER, packs INTEGER, bag_n INTEGER, beaten INTEGER, rare INTEGER, legends INTEGER, max_lvl INTEGER,
  flags TEXT
);
CREATE INDEX IF NOT EXISTS audit_cid ON audit (cid, id);

-- Prizes: weekly top 3 and Journey milestones; codes are created in Shopify when a prize is issued
CREATE TABLE IF NOT EXISTS prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cid TEXT NOT NULL,
  kind TEXT NOT NULL,          -- weekly | milestone
  ref TEXT NOT NULL,           -- week start date, or milestone key
  pct INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,        -- needs_eligibility | review | issued | rejected
  code TEXT, note TEXT,
  created TEXT NOT NULL, issued TEXT, expires TEXT,
  UNIQUE (cid, kind, ref)
);
