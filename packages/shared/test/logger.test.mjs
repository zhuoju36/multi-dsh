import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../src/logger.mjs'

test('logger writes JSON lines with service, level and fields', () => {
  const lines = []
  const logger = createLogger({
    service: 'test',
    sink: { write: (chunk) => lines.push(chunk) },
    clock: () => new Date('2026-11-13T00:00:00.000Z'),
  })
  logger.info({ userId: 'usr_1' }, 'hello')
  logger.debug({ ignored: true })
  const record = JSON.parse(lines[0])
  assert.equal(record.service, 'test')
  assert.equal(record.level, 'info')
  assert.equal(record.userId, 'usr_1')
  assert.equal(record.msg, 'hello')
  assert.equal(record.t, '2026-11-13T00:00:00.000Z')
  assert.equal(lines.length, 1, 'debug below threshold is dropped')
})

test('logger requires a service name', () => {
  assert.throws(() => createLogger({}), /service is required/)
})
