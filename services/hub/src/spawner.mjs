/** Docker Compose spawner: one tenant project per user, driven from the host. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request } from 'node:http'
import { composeArgs } from '@multi-dsh/tenant/compose'

const execFileAsync = promisify(execFile)

/**
 * @param {{dataRoot: string, composeFile: string, tenantEnvDir: string, dockerBin: string, helperImage: string}} config
 * @param {{run?: typeof execFileAsync}} [deps]
 */
export function createDockerSpawner(config, { run = execFileAsync } = {}) {
  /**
   * @param {string[]} args
   * @param {{timeout?: number}} [options]
   * @returns {Promise<string>}
   */
  async function docker(args, { timeout = 120_000 } = {}) {
    try {
      const result = await run(config.dockerBin, args, { timeout, maxBuffer: 10 * 1024 * 1024 })
      return String(result.stdout ?? '').trim()
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? error).trim()
      throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${detail}`)
    }
  }

  /**
   * @param {string} userId
   * @returns {Promise<'running' | 'exited' | 'created' | 'paused' | 'restarting' | null>}
   */
  async function status(userId) {
    try {
      const value = await docker(['inspect', '-f', '{{.State.Status}}', userId], { timeout: 10_000 })
      return /** @type {any} */ (value || null)
    } catch {
      return null
    }
  }

  /**
   * Create the tenant data dir owned by the container UID (10001).
   * @param {string} userId
   */
  async function ensureDataDir(userId) {
    if (!/^[a-z0-9_]+$/i.test(userId)) throw new Error(`invalid user id: ${userId}`)
    await docker([
      'run', '--rm', '--user', '0',
      '-v', `${config.dataRoot}:/v`,
      '--entrypoint', '/bin/bash',
      config.helperImage,
      '-c', `mkdir -p /v/${userId}/data && chown -R 10001:10001 /v/${userId} && chmod 700 /v/${userId}/data`,
    ])
  }

  /**
   * @param {string} userId
   * @param {string} envFile
   */
  async function start(userId, envFile) {
    await docker(composeArgs({ userId, composeFile: config.composeFile, envFile, action: 'up' }), { timeout: 300_000 })
  }

  /**
   * @param {string} userId
   */
  async function stop(userId) {
    try {
      await docker(['stop', userId], { timeout: 60_000 })
    } catch {
      // already stopped / container missing
    }
  }

  /**
   * Ask the tenant gateway for activity (HTTP + open WebSocket connections).
   * @param {number} hostPort
   * @param {() => number} now
   * @returns {Promise<{lastActivity: string, openConnections: number} | null>}
   */
  function activity(hostPort, now) {
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: hostPort, path: '/internal/activity', method: 'GET', timeout: 2000 }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve(null)
          }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.end()
    })
  }

  return { status, ensureDataDir, start, stop, activity }
}
