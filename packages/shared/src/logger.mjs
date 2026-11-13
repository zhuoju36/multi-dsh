/** Structured JSON-lines logger shared by platform services. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Create a logger writing one JSON object per line.
 * @param {{service: string, level?: string, sink?: {write(chunk: string): unknown}, clock?: () => Date}} options
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
export function createLogger({ service, level = 'info', sink = process.stdout, clock = () => new Date() } = {}) {
  if (!service) throw new Error('createLogger: service is required')
  const threshold = LEVELS[level] ?? LEVELS.info

  function emit(lvl, fields, message) {
    if (LEVELS[lvl] < threshold) return
    const record = { t: clock().toISOString(), level: lvl, service }
    if (message !== undefined) record.msg = message
    if (fields !== undefined) Object.assign(record, fields)
    sink.write(`${JSON.stringify(record)}\n`)
  }

  return {
    debug: (fields, message) => emit('debug', fields, message),
    info: (fields, message) => emit('info', fields, message),
    warn: (fields, message) => emit('warn', fields, message),
    error: (fields, message) => emit('error', fields, message),
  }
}
