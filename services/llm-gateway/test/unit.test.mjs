import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageTracker } from '../src/sse.mjs'
import { resolveRoute } from '../src/routes.mjs'
import { extractKey } from '../src/keys.mjs'

test('usage tracker parses message_start and message_delta across chunk boundaries', () => {
  const tracker = createUsageTracker()
  const payload = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-flash","usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  for (const chunk of payload.match(/.{1,13}/gs)) tracker.feed(Buffer.from(chunk, 'utf8'))
  assert.deepEqual(tracker.finish(), {
    model: 'deepseek-v4-flash',
    inputTokens: 12,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  })
})

test('usage tracker ignores malformed events', () => {
  const tracker = createUsageTracker()
  tracker.feed(Buffer.from('data: not-json\n\n', 'utf8'))
  tracker.feed(Buffer.from(': keep-alive comment\n\n', 'utf8'))
  assert.deepEqual(tracker.finish(), {
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
})

test('route table maps DSH requests to explicit upstream paths', () => {
  const config = { upstreamBaseUrl: 'https://api.deepseek.com/anthropic', upstreamOrigin: 'https://api.deepseek.com' }
  assert.equal(resolveRoute('POST', '/v1/messages', config).upstream, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(resolveRoute('POST', '/v1/files/x', config).upstream, 'https://api.deepseek.com/anthropic/v1/files/x')
  assert.equal(resolveRoute('GET', '/models', config).upstream, 'https://api.deepseek.com/models')
  assert.equal(resolveRoute('POST', '/v1/tools/search?q=1', config).upstream, 'https://api.deepseek.com/v1/tools/search?q=1')
  assert.equal(resolveRoute('POST', '/v1/tools/fetch', config).kind, 'tools')
  assert.equal(resolveRoute('POST', '/v1/messages/count_tokens', config), null)
  assert.equal(resolveRoute('GET', '/v1/messages', config), null)
})

test('extractKey reads x-api-key and Bearer', () => {
  assert.equal(extractKey({ 'x-api-key': 'sk-a' }), 'sk-a')
  assert.equal(extractKey({ authorization: 'Bearer sk-b' }), 'sk-b')
  assert.equal(extractKey({ authorization: 'bearer sk-c' }), 'sk-c')
  assert.equal(extractKey({}), null)
  assert.equal(extractKey({ authorization: 'Basic abc' }), null)
})
