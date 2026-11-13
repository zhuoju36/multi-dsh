/** Explicit upstream route table for the DSH Messages protocol and its side channels. */

/**
 * @typedef {object} Route
 * @property {'messages' | 'files' | 'models' | 'tools'} kind
 * @property {string} upstream
 */

/**
 * Resolve a DSH request to an upstream URL. Anything not listed is refused.
 * @param {string} method
 * @param {string} rawUrl
 * @param {{upstreamBaseUrl: string, upstreamOrigin: string}} config
 * @returns {Route | null}
 */
export function resolveRoute(method, rawUrl, config) {
  const url = new URL(rawUrl ?? '/', 'http://llm-gateway')
  const path = url.pathname
  const search = url.search

  if (method === 'POST' && path === '/v1/messages') {
    return { kind: 'messages', upstream: `${config.upstreamBaseUrl}/v1/messages${search}` }
  }
  if (['POST', 'GET', 'DELETE'].includes(method) && (path === '/v1/files' || path.startsWith('/v1/files/'))) {
    return { kind: 'files', upstream: `${config.upstreamBaseUrl}${path}${search}` }
  }
  if (method === 'GET' && path === '/models') {
    return { kind: 'models', upstream: `${config.upstreamOrigin}/models${search}` }
  }
  if (method === 'POST' && (path === '/v1/tools/search' || path === '/v1/tools/fetch')) {
    return { kind: 'tools', upstream: `${config.upstreamOrigin}${path}${search}` }
  }
  return null
}
