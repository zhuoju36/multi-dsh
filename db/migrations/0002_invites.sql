-- Invite-based registration and instance lifecycle metadata (phase 1.5).

ALTER TABLE instances ADD COLUMN IF NOT EXISTS stop_reason text;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS spawner_state jsonb;

CREATE TABLE IF NOT EXISTS invites (
  id         text PRIMARY KEY,
  code_hash  text NOT NULL UNIQUE,
  kind       text NOT NULL DEFAULT 'invite',   -- invite | reset
  user_id    text REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  max_uses   integer NOT NULL DEFAULT 1,
  uses       integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS invites_code_idx ON invites (code_hash);
