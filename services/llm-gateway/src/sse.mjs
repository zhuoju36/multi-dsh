/** Incremental Anthropic Messages SSE parser: extracts token usage without buffering the response. */
import { StringDecoder } from 'node:string_decoder'

/**
 * @returns {{feed: (chunk: Buffer) => void, finish: () => {model: string | null, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}}}
 */
export function createUsageTracker() {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const usage = { model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

  function handleData(text) {
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return
    }
    if (payload?.type === 'message_start' && payload.message) {
      if (typeof payload.message.model === 'string') usage.model = payload.message.model
      const counters = payload.message.usage ?? {}
      usage.inputTokens = Number(counters.input_tokens ?? 0) || 0
      usage.cacheReadTokens = Number(counters.cache_read_input_tokens ?? 0) || 0
      usage.cacheWriteTokens = Number(counters.cache_creation_input_tokens ?? 0) || 0
      return
    }
    if (payload?.type === 'message_delta' && payload.usage) {
      usage.outputTokens = Number(payload.usage.output_tokens ?? 0) || 0
    }
  }

  function processLines(final = false) {
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.startsWith('data:')) handleData(line.slice(5).trim())
    }
    if (final && buffer.length > 0) {
      if (buffer.startsWith('data:')) handleData(buffer.slice(5).trim())
      buffer = ''
    }
  }

  return {
    feed(chunk) {
      buffer += decoder.write(chunk)
      processLines()
    },
    finish() {
      buffer += decoder.end()
      processLines(true)
      return { ...usage }
    },
  }
}
