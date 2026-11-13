/** Thin wrappers around `docker compose` for one tenant project. */
import { spawn } from 'node:child_process'

/**
 * @param {{userId: string, composeFile: string, envFile: string, action: 'up' | 'recreate' | 'down'}} options
 * @returns {string[]}
 */
export function composeArgs({ userId, composeFile, envFile, action }) {
  const base = ['compose', '-p', `dsh-${userId}`, '-f', composeFile, '--env-file', envFile]
  if (action === 'up') return [...base, 'up', '-d', '--wait']
  if (action === 'recreate') return [...base, 'up', '-d', '--wait', '--force-recreate']
  if (action === 'down') return [...base, 'down']
  throw new Error(`unknown compose action: ${action}`)
}

/**
 * Run one compose action, inheriting stdout/stderr.
 * @param {{dockerBin: string, action: 'up' | 'recreate' | 'down', userId: string, composeFile: string, envFile: string}} options
 * @param {{spawnImpl?: typeof spawn}} [deps]
 * @returns {Promise<void>}
 */
export function runCompose(options, { spawnImpl = spawn } = {}) {
  const args = composeArgs(options)
  return new Promise((resolve, reject) => {
    const child = spawnImpl(options.dockerBin, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`docker ${args.join(' ')} failed (code ${String(code ?? signal)})`))
    })
  })
}
