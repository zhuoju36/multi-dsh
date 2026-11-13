/** PostgreSQL access shared by auth, llm-gateway and provisioner. */
import pg from 'pg'

const { Pool } = pg

/**
 * Create a pooled connection from a connection string.
 * @param {{connectionString: string, max?: number}} options
 * @returns {import('pg').Pool}
 */
export function createPool({ connectionString, max = 10 }) {
  if (!connectionString) throw new Error('createPool: connectionString is required')
  return new Pool({ connectionString, max })
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} username
 */
export async function findUserByUsername(pool, username) {
  const { rows } = await pool.query(
    'SELECT id, username, password_hash, status FROM users WHERE username = $1',
    [username],
  )
  return rows[0] ?? null
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} id
 */
export async function findUserById(pool, id) {
  const { rows } = await pool.query(
    'SELECT id, username, password_hash, status FROM users WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

/**
 * @param {import('pg').Pool} pool
 * @param {{id: string, username: string, passwordHash: string}} user
 */
export async function createUser(pool, { id, username, passwordHash }) {
  const { rows } = await pool.query(
    'INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username, status',
    [id, username, passwordHash],
  )
  return rows[0]
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} id
 * @param {string} passwordHash
 */
export async function setUserPassword(pool, id, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash])
}

/**
 * Disable a user without deleting history (auth and gateway both reject it).
 * @param {import('pg').Pool} pool
 * @param {string} id
 */
export async function disableUser(pool, id) {
  await pool.query("UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1", [id])
}

/**
 * @param {import('pg').Pool} pool
 * @param {{idHash: string, userId: string, ttlMs: number}} session
 */
export async function createSession(pool, { idHash, userId, ttlMs }) {
  await pool.query(
    'INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3::bigint * interval \'1 millisecond\'))',
    [idHash, userId, String(ttlMs)],
  )
}

/**
 * Resolve a valid session joined with its active user.
 * @param {import('pg').Pool} pool
 * @param {string} idHash
 */
export async function findSession(pool, idHash) {
  const { rows } = await pool.query(
    `SELECT s.user_id, s.expires_at, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [idHash],
  )
  return rows[0] ?? null
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} idHash
 */
export async function touchSession(pool, idHash) {
  await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1', [idHash])
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} idHash
 */
export async function revokeSession(pool, idHash) {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL', [idHash])
}

/**
 * @param {import('pg').Pool} pool
 */
export async function deleteExpiredSessions(pool) {
  await pool.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'")
}

/**
 * Count failed logins for one account+IP inside the window.
 * @param {import('pg').Pool} pool
 * @param {{username: string, ip: string | null, windowMs: number}} options
 */
export async function countRecentFailures(pool, { username, ip, windowMs }) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS failures
       FROM login_attempts
      WHERE username = $1
        AND COALESCE(ip, '') = COALESCE($2, '')
        AND ok = false
        AND ts > now() - ($3::bigint * interval '1 millisecond')`,
    [username, ip, String(windowMs)],
  )
  return rows[0]?.failures ?? 0
}

/**
 * @param {import('pg').Pool} pool
 * @param {{username: string, ip: string | null, ok: boolean}} attempt
 */
export async function recordLoginAttempt(pool, { username, ip, ok }) {
  await pool.query('INSERT INTO login_attempts (username, ip, ok) VALUES ($1, $2, $3)', [username, ip, ok])
}

/**
 * Claim the lowest free port (cooling ports become reusable after 30 days).
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<number | null>}
 */
export async function allocatePort(pool, userId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `WITH candidate AS (
         SELECT port FROM ports
          WHERE state = 'free'
             OR (state = 'cooling' AND released_at < now() - interval '30 days')
          ORDER BY port
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ports p
          SET state = 'in_use', user_id = $1, released_at = NULL
         FROM candidate c
        WHERE p.port = c.port
       RETURNING p.port`,
      [userId],
    )
    await client.query('COMMIT')
    return rows[0]?.port ?? null
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 */
export async function releasePort(pool, userId) {
  await pool.query("UPDATE ports SET state = 'cooling', released_at = now() WHERE user_id = $1", [userId])
}

/**
 * @param {import('pg').Pool} pool
 * @param {{userId: string, hostPort: number, status?: string, imageDigest?: string | null, dshVersion?: string | null}} instance
 */
export async function upsertInstance(pool, { userId, hostPort, status = 'pending', imageDigest = null, dshVersion = null }) {
  const { rows } = await pool.query(
    `INSERT INTO instances (user_id, host_port, status, image_digest, dsh_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE
       SET host_port = EXCLUDED.host_port,
           status = EXCLUDED.status,
           image_digest = COALESCE(EXCLUDED.image_digest, instances.image_digest),
           dsh_version = COALESCE(EXCLUDED.dsh_version, instances.dsh_version),
           updated_at = now()
     RETURNING *`,
    [userId, hostPort, status, imageDigest, dshVersion],
  )
  return rows[0]
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} hostPort
 */
export async function findInstanceByPort(pool, hostPort) {
  const { rows } = await pool.query(
    'SELECT user_id, host_port, status FROM instances WHERE host_port = $1',
    [hostPort],
  )
  return rows[0] ?? null
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 */
export async function getInstanceByUser(pool, userId) {
  const { rows } = await pool.query('SELECT * FROM instances WHERE user_id = $1', [userId])
  return rows[0] ?? null
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @param {string} status
 * @param {{imageDigest?: string | null, dshVersion?: string | null}} [meta]
 */
export async function setInstanceStatus(pool, userId, status, meta = {}) {
  await pool.query(
    `UPDATE instances
        SET status = $2,
            image_digest = COALESCE($3, image_digest),
            dsh_version = COALESCE($4, dsh_version),
            updated_at = now()
      WHERE user_id = $1`,
    [userId, status, meta.imageDigest ?? null, meta.dshVersion ?? null],
  )
}

/**
 * @param {import('pg').Pool} pool
 */
export async function listInstances(pool) {
  const { rows } = await pool.query(
    `SELECT i.user_id, u.username, i.host_port, i.status, i.dsh_version, i.updated_at
       FROM instances i JOIN users u ON u.id = i.user_id
      ORDER BY i.host_port`,
  )
  return rows
}

/**
 * @param {import('pg').Pool} pool
 * @param {{id: string, userId: string, keyHash: string}} key
 */
export async function createTenantKey(pool, { id, userId, keyHash }) {
  await pool.query('INSERT INTO tenant_keys (id, user_id, key_hash) VALUES ($1, $2, $3)', [id, userId, keyHash])
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} keyHash
 */
export async function resolveTenantKey(pool, keyHash) {
  const { rows } = await pool.query(
    `SELECT k.user_id
       FROM tenant_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.status = 'active'`,
    [keyHash],
  )
  return rows[0]?.user_id ?? null
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 */
export async function revokeTenantKeys(pool, userId) {
  await pool.query('UPDATE tenant_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
}

/**
 * @param {import('pg').Pool} pool
 * @param {{userId: string, kind: string, model?: string | null, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, status: number, durationMs?: number | null, requestId?: string | null}} row
 */
export async function recordUsage(pool, row) {
  await pool.query(
    `INSERT INTO llm_usage
       (user_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, status, duration_ms, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.userId,
      row.kind,
      row.model ?? null,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.cacheReadTokens ?? 0,
      row.cacheWriteTokens ?? 0,
      row.status,
      row.durationMs ?? null,
      row.requestId ?? null,
    ],
  )
}

/**
 * Sum usage for one user since an instant.
 * @param {import('pg').Pool} pool
 * @param {{userId: string, since: Date}} options
 */
export async function usageForUserSince(pool, { userId, since }) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(input_tokens), 0)::bigint AS input_tokens,
            COALESCE(sum(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
            COALESCE(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens
       FROM llm_usage
      WHERE user_id = $1 AND ts >= $2`,
    [userId, since],
  )
  return rows[0]
}

/**
 * Aggregate usage per user between two instants (upper bound exclusive).
 * @param {import('pg').Pool} pool
 * @param {{since: Date, until?: Date | null}} options
 */
export async function usageByUserSince(pool, { since, until = null }) {
  const { rows } = await pool.query(
    `SELECT l.user_id,
            u.username,
            COALESCE(sum(l.input_tokens), 0)::bigint AS input_tokens,
            COALESCE(sum(l.output_tokens), 0)::bigint AS output_tokens,
            COALESCE(sum(l.cache_read_tokens), 0)::bigint AS cache_read_tokens,
            COALESCE(sum(l.cache_write_tokens), 0)::bigint AS cache_write_tokens,
            count(*)::int AS requests
       FROM llm_usage l
       JOIN users u ON u.id = l.user_id
      WHERE l.ts >= $1
        AND ($2::timestamptz IS NULL OR l.ts < $2)
      GROUP BY l.user_id, u.username
      ORDER BY u.username`,
    [since, until],
  )
  return rows
}

/**
 * @param {import('pg').Pool} pool
 * @param {{actor?: string | null, action: string, target?: string | null, ip?: string | null, detail?: unknown}} entry
 */
export async function writeAudit(pool, entry) {
  await pool.query(
    'INSERT INTO audit_log (actor, action, target, ip, detail) VALUES ($1, $2, $3, $4, $5)',
    [entry.actor ?? null, entry.action, entry.target ?? null, entry.ip ?? null, entry.detail === undefined ? null : JSON.stringify(entry.detail)],
  )
}

/**
 * @param {import('pg').Pool} pool
 * @param {{id: string, codeHash: string, kind?: 'invite'|'reset', userId?: string|null, expiresAt: Date, maxUses?: number, createdBy?: string|null}} invite
 */
export async function createInvite(pool, { id, codeHash, kind = 'invite', userId = null, expiresAt, maxUses = 1, createdBy = null }) {
  const { rows } = await pool.query(
    `INSERT INTO invites (id, code_hash, kind, user_id, expires_at, max_uses, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, kind, user_id, expires_at, max_uses`,
    [id, codeHash, kind, userId, expiresAt, maxUses, createdBy],
  )
  return rows[0]
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} codeHash
 */
export async function findInviteByCodeHash(pool, codeHash) {
  const { rows } = await pool.query(
    'SELECT id, kind, user_id, expires_at, max_uses, uses, revoked_at FROM invites WHERE code_hash = $1',
    [codeHash],
  )
  return rows[0] ?? null
}

/**
 * @param {unknown} invite
 * @param {'invite'|'reset'} kind
 */
function assertInviteUsable(invite, kind) {
  const row = /** @type {any} */ (invite)
  const usable = row
    && row.kind === kind
    && row.revoked_at === null
    && Number(row.uses) < Number(row.max_uses)
    && new Date(row.expires_at).getTime() > Date.now()
  if (!usable) {
    const error = new Error('invite is invalid, expired or already used')
    // @ts-expect-error custom code for the auth caller
    error.code = 'INVALID_INVITE'
    throw error
  }
}

/**
 * Atomically create a user and consume an invite code.
 * @param {import('pg').Pool} pool
 * @param {{id: string, username: string, passwordHash: string, codeHash: string}} input
 */
export async function registerUserWithInvite(pool, { id, username, passwordHash, codeHash }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM invites WHERE code_hash = $1 FOR UPDATE', [codeHash])
    assertInviteUsable(rows[0], 'invite')
    const inserted = await client.query(
      'INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username, status',
      [id, username, passwordHash],
    )
    await client.query('UPDATE invites SET uses = uses + 1 WHERE id = $1', [rows[0].id])
    await client.query('COMMIT')
    return inserted.rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    if (error?.code === '23505') {
      const taken = new Error('username already exists')
      // @ts-expect-error custom code for the auth caller
      taken.code = 'USERNAME_TAKEN'
      throw taken
    }
    throw error
  } finally {
    client.release()
  }
}

/**
 * Consume a reset invite, set a new password and revoke all sessions.
 * @param {import('pg').Pool} pool
 * @param {{codeHash: string, passwordHash: string}} input
 * @returns {Promise<string>} user id
 */
export async function resetPasswordWithInvite(pool, { codeHash, passwordHash }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM invites WHERE code_hash = $1 FOR UPDATE', [codeHash])
    assertInviteUsable(rows[0], 'reset')
    const invite = rows[0]
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [invite.user_id, passwordHash])
    await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [invite.user_id])
    await client.query('UPDATE invites SET uses = uses + 1 WHERE id = $1', [invite.id])
    await client.query('COMMIT')
    return invite.user_id
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} userId
 */
export async function setInstanceStopped(pool, userId, reason = null) {
  await pool.query(
    "UPDATE instances SET status = 'stopped', stop_reason = $2, updated_at = now() WHERE user_id = $1",
    [userId, reason],
  )
}

/**
 * @param {import('pg').Pool} pool
 */
export async function listInstancesFull(pool) {
  const { rows } = await pool.query(
    `SELECT i.*, u.username
       FROM instances i JOIN users u ON u.id = i.user_id
      ORDER BY i.host_port`,
  )
  return rows
}
