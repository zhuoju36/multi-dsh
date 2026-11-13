/** Environment configuration helpers. Every service validates at boot and fails fast. */

/**
 * Read a required environment variable.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireEnv(name, env = process.env) {
  const value = env[name]
  if (value === undefined || value === '') throw new Error(`missing required environment variable: ${name}`)
  return value
}

/**
 * Read an optional environment variable with a default for unset or empty values.
 * @param {string} name
 * @param {string} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function optionalEnv(name, fallback, env = process.env) {
  const value = env[name]
  return value === undefined || value === '' ? fallback : value
}

/**
 * Read a non-negative integer environment variable.
 * @param {string} name
 * @param {number} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function intEnv(name, fallback, env = process.env) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  return value
}

/**
 * Read a boolean environment variable (`1`/`true`/`yes`).
 * @param {string} name
 * @param {boolean} fallback
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function boolEnv(name, fallback, env = process.env) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}
