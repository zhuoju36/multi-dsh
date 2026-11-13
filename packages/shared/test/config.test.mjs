import test from 'node:test'
import assert from 'node:assert/strict'
import { requireEnv, optionalEnv, intEnv, boolEnv } from '../src/config.mjs'

test('requireEnv rejects missing and empty values', () => {
  assert.equal(requireEnv('X', { X: 'v' }), 'v')
  assert.throws(() => requireEnv('X', {}), /missing required/)
  assert.throws(() => requireEnv('X', { X: '' }), /missing required/)
})

test('optionalEnv treats unset and empty as absent', () => {
  assert.equal(optionalEnv('X', 'fallback', {}), 'fallback')
  assert.equal(optionalEnv('X', 'fallback', { X: '' }), 'fallback')
  assert.equal(optionalEnv('X', 'fallback', { X: 'value' }), 'value')
})

test('intEnv validates non-negative integers', () => {
  assert.equal(intEnv('X', 7, {}), 7)
  assert.equal(intEnv('X', 7, { X: '42' }), 42)
  assert.equal(intEnv('X', 7, { X: '0' }), 0)
  assert.throws(() => intEnv('X', 7, { X: '-1' }), /non-negative integer/)
  assert.throws(() => intEnv('X', 7, { X: '1.5' }), /non-negative integer/)
  assert.throws(() => intEnv('X', 7, { X: 'abc' }), /non-negative integer/)
})

test('boolEnv accepts common truthy spellings', () => {
  assert.equal(boolEnv('X', false, {}), false)
  assert.equal(boolEnv('X', false, { X: '1' }), true)
  assert.equal(boolEnv('X', false, { X: 'TRUE' }), true)
  assert.equal(boolEnv('X', true, { X: '0' }), false)
})
