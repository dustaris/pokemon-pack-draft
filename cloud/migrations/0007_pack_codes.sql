-- Pack codes: redeemable for free packs, once per account
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  packs INTEGER NOT NULL,
  max_uses INTEGER,            -- NULL = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  expires TEXT,                -- ISO date, NULL = never
  note TEXT,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS redemptions (
  code TEXT NOT NULL,
  cid TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (code, cid)
);
CREATE TABLE IF NOT EXISTS redeem_fails (
  cid TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cid, day)
);
ALTER TABLE players ADD COLUMN bonus_packs INTEGER NOT NULL DEFAULT 0;
