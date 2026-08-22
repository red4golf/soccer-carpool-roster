-- Invitations: how a parent gets into a club at all.
--
-- The original app let anyone create an account and then wait for approval,
-- which meant an unbounded queue of strangers attached to a club full of
-- children's data. Here access starts with a coordinator naming an email
-- address. No invite, no membership — a signed-in stranger sees nothing and
-- is told to ask their coordinator.
--
-- Because an admin has already vouched for the address, claiming an invite
-- creates an ACTIVE membership: the approval happened at invite time, and a
-- second approval step would just be a queue nobody drains.

CREATE TABLE invitations (
  id         INTEGER PRIMARY KEY,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  team_id    INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('parent','coach','team_admin')),
  invited_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  claimed_by INTEGER REFERENCES users(id)
);

-- One live invite per email per team. Re-inviting replaces rather than stacks.
CREATE UNIQUE INDEX idx_invite_unique ON invitations(club_id, IFNULL(team_id, 0), email);
CREATE INDEX idx_invite_email ON invitations(email, claimed_at);
