import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCookies, serializeCookie, stripCookies } from '../src/cookies.mjs'

test('parseCookies splits name=value pairs', () => {
  assert.deepEqual(parseCookies(undefined), {})
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' })
  assert.deepEqual(parseCookies('novalue; c=3=4'), { c: '3=4' })
})

test('serializeCookie emits attributes', () => {
  assert.equal(
    serializeCookie('mdsh_session', 'abc', { maxAge: 3600 }),
    'mdsh_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600',
  )
  assert.equal(
    serializeCookie('x', 'y', { httpOnly: false, sameSite: false, secure: true, path: '/ui' }),
    'x=y; Path=/ui; Secure',
  )
})

test('stripCookies removes only the named cookies', () => {
  assert.equal(stripCookies('mdsh_session=s; dsh-auth-x=v', ['mdsh_session']), 'dsh-auth-x=v')
  assert.equal(stripCookies('mdsh_session=s', ['mdsh_session']), undefined)
  assert.equal(stripCookies(undefined, ['mdsh_session']), undefined)
  assert.equal(stripCookies('a=1; b=2', ['c']), 'a=1; b=2')
})
