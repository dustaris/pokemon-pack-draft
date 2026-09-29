-- Anonymous daily play counts: one ping per browser per day, no identifiers stored
CREATE TABLE IF NOT EXISTS visits (
  day TEXT NOT NULL,          -- Pacific date
  kind TEXT NOT NULL,         -- 'guest' or 'member'
  browsers INTEGER NOT NULL DEFAULT 0,
  packs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
