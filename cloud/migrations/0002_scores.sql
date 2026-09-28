CREATE TABLE IF NOT EXISTS scores (
  day TEXT NOT NULL,          -- Daily Challenge day (America/Los_Angeles), YYYY-MM-DD
  cid TEXT NOT NULL,          -- Shopify customer id
  name TEXT NOT NULL,         -- trainer name shown on the leaderboard
  tries INTEGER NOT NULL,     -- ranked tries used today (max 3)
  best INTEGER NOT NULL,      -- best score today
  stars INTEGER NOT NULL,     -- stars for the best try
  at TEXT NOT NULL,           -- when the best score was set (earlier wins ties)
  PRIMARY KEY (day, cid)
);
CREATE INDEX IF NOT EXISTS scores_board ON scores (day, best DESC, at);
