/** Minimal cookie helpers: request parsing, response serialization, request filtering. */

/**
 * Parse a Cookie request header into a name→value object.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name) out[name] = part.slice(index + 1).trim()
  }
  return out
}

/**
 * Serialize one Set-Cookie value.
 * @param {string} name
 * @param {string} value
 * @param {{maxAge?: number, path?: string, httpOnly?: boolean, sameSite?: 'Lax'|'Strict'|'None'|false, secure?: boolean}} [options]
 * @returns {string}
 */
export function serializeCookie(name, value, options = {}) {
  const { maxAge, path = '/', httpOnly = true, sameSite = 'Lax', secure = false } = options
  const parts = [`${name}=${value}`, `Path=${path}`]
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (sameSite) parts.push(`SameSite=${sameSite}`)
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`)
  return parts.join('; ')
}

/**
 * Drop named cookies from a Cookie request header, preserving the rest.
 * @param {string | undefined} header
 * @param {readonly string[]} names
 * @returns {string | undefined}
 */
export function stripCookies(header, names) {
  if (!header) return undefined
  const kept = []
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!names.includes(name)) kept.push(part.trim())
  }
  return kept.length > 0 ? kept.join('; ') : undefined
}
