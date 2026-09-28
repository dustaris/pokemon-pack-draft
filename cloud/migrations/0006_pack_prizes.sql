-- Prize cards in packs: per-player prize chances (3 a day, banking up to 6, +3 once for subscribers) and credit amounts
ALTER TABLE players ADD COLUMN chances INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN chances_day TEXT;
ALTER TABLE players ADD COLUMN sub_bonus INTEGER NOT NULL DEFAULT 0;
ALTER TABLE prizes ADD COLUMN amount REAL NOT NULL DEFAULT 0;
