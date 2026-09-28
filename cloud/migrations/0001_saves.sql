CREATE TABLE IF NOT EXISTS saves (
  cid TEXT PRIMARY KEY,      -- Shopify customer id
  rev INTEGER NOT NULL,      -- bumps on every accepted save
  updated TEXT NOT NULL,     -- ISO time of the last save
  data TEXT NOT NULL         -- the game's save JSON
);
