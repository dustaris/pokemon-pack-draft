-- Pack codes can also carry Golden Ticket chances; those go in a pool that does not reset daily
ALTER TABLE codes ADD COLUMN chances INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN bonus_chances INTEGER NOT NULL DEFAULT 0;
