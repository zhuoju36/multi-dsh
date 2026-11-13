/** Minimal Hub client over a Unix socket. */
import { request } from 'node:http'

/**
 * @param {{socketPath: string, token: string, timeoutMs?: number}} options
 */
export function createHubClient({ socketPath, token, timeoutMs = 30_000 }) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  function call(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path,
          method,
          timeout: timeoutMs,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload === undefined ? {} : {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }),
          },
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { text += chunk })
          response.on('end', () => {
            let parsed
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = undefined
            }
            if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) {
              resolve(parsed)
              return
            }
            const error = new Error(parsed?.error ?? `hub ${response.statusCode}`)
            // @ts-expect-error statusCode is useful to callers
            error.statusCode = response.statusCode
            reject(error)
          })
        },
      )
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => req.destroy(new Error('hub request timeout')))
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  return {
    /** @param {string} userId */
    ensure: (userId) => call('POST', '/internal/instances', { user_id: userId }),
    /** @param {string} userId */
    status: (userId) => call('GET', `/internal/instances/${encodeURIComponent(userId)}`),
    /** @param {string} userId @param {string} [reason] */
    stop: (userId, reason) => call('POST', `/internal/instances/${encodeURIComponent(userId)}/stop`, { reason }),
  }
}
