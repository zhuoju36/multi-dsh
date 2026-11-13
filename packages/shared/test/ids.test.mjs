import test from 'node:test'
import assert from 'node:assert/strict'
import { opaqueId, randomToken, sha256Hex, timingSafeEqualText } from '../src/ids.mjs'

test('opaqueId has the documented shape', () => {
  const id = opaqueId('usr')
  assert.match(id, /^usr_[a-z2-7]{16}$/)
  assert.notEqual(opaqueId('usr'), opaqueId('usr'))
  assert.match(opaqueId('llm', 4), /^llm_[a-z2-7]{7}$/)
})

test('randomToken is url-safe and unique', () => {
  const token = randomToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(randomToken(), token)
})

test('sha256Hex is stable', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('timingSafeEqualText compares equal-length values only', () => {
  assert.equal(timingSafeEqualText('secret', 'secret'), true)
  assert.equal(timingSafeEqualText('secret', 'secreT'), false)
  assert.equal(timingSafeEqualText('secret', 'secret2'), false)
})
