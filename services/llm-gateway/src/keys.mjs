/** Virtual-key extraction: Messages uses x-api-key, Search/Fetch use Bearer. */

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {string | null}
 */
export function extractKey(headers) {
  const direct = headers['x-api-key']
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  const authorization = headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match) return match[1].trim()
  }
  return null
}
