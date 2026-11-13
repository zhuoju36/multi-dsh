import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../lib/config.mjs'

test('loadConfig fails closed without auth URLs', () => {
  assert.throws(() => loadConfig({}), /AUTH_INTERNAL_URL is required/)
  assert.throws(() => loadConfig({ AUTH_INTERNAL_URL: 'http://auth:18080' }), /AUTH_PUBLIC_URL is required/)
})

test('loadConfig accepts explicit URLs and validates them', () => {
  const config = loadConfig({
    AUTH_INTERNAL_URL: 'http://auth:18080/',
    AUTH_PUBLIC_URL: 'http://127.0.0.1:18080/',
    TENANT_ID: 'usr_a',
    USER_HOST: '127.0.0.1:18001',
  })
  assert.equal(config.authInternalUrl, 'http://auth:18080')
  assert.equal(config.authPublicUrl, 'http://127.0.0.1:18080')
  assert.equal(config.tenantId, 'usr_a')
  assert.equal(config.devMode, false)
  assert.equal(config.maxClientBodyBytes, 320 * 1024 * 1024)
  assert.throws(() => loadConfig({ AUTH_INTERNAL_URL: 'ftp://x', AUTH_PUBLIC_URL: 'http://y' }), /must use http/)
  assert.throws(() => loadConfig({ AUTH_INTERNAL_URL: 'not a url', AUTH_PUBLIC_URL: 'http://y' }), /absolute URL/)
})

test('loadConfig allows dev mode without auth', () => {
  const config = loadConfig({ GATEWAY_DEV_MODE: '1' })
  assert.equal(config.devMode, true)
  assert.equal(config.authInternalUrl, '')
  assert.equal(config.listenPort, 8080)
  assert.equal(config.userHost, '127.0.0.1:8080')
})
