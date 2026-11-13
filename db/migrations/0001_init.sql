-- multi-dsh initial schema (phase 1)
-- One row per user, one live instance per user, server-side sessions,
-- per-tenant virtual keys, per-user LLM usage, audit and login rate limits.

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash      text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS ports (
  port        integer PRIMARY KEY,
  state       text NOT NULL DEFAULT 'free',
  user_id     text,
  released_at timestamptz
);
INSERT INTO ports (port) SELECT generate_series(18001, 18100) ON CONFLICT (port) DO NOTHING;

CREATE TABLE IF NOT EXISTS instances (
  user_id      text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  host_port    integer NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'pending',
  image_digest text,
  dsh_version  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz
);

CREATE TABLE IF NOT EXISTS tenant_keys (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash   text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS tenant_keys_user_idx ON tenant_keys (user_id);

CREATE TABLE IF NOT EXISTS llm_usage (
  id                 bigserial PRIMARY KEY,
  user_id            text NOT NULL,
  kind               text NOT NULL,
  model              text,
  input_tokens       bigint NOT NULL DEFAULT 0,
  output_tokens      bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  status             integer NOT NULL,
  duration_ms        integer,
  request_id         text,
  ts                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_usage_user_ts_idx ON llm_usage (user_id, ts);
CREATE INDEX IF NOT EXISTS llm_usage_ts_idx ON llm_usage (ts);

CREATE TABLE IF NOT EXISTS audit_log (
  id     bigserial PRIMARY KEY,
  ts     timestamptz NOT NULL DEFAULT now(),
  actor  text,
  action text NOT NULL,
  target text,
  ip     text,
  detail jsonb
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id       bigserial PRIMARY KEY,
  username text NOT NULL,
  ip       text,
  ok       boolean NOT NULL,
  ts       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_username_ts_idx ON login_attempts (username, ts);
