const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeKeyStore } = require('../keystore');

function tmpConfig() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ks-')), 'config.json');
}
// Plaintext store (encryption unavailable)
function plainStore(env = {}) {
  return makeKeyStore({
    configPath: tmpConfig(),
    encrypt: (s) => Buffer.from(s),
    decrypt: (b) => b.toString(),
    isEncryptionAvailable: () => false,
    env,
  });
}
// Encrypted store (reversible fake cipher)
function encStore(env = {}) {
  const rot = (s) => Buffer.from(s.split('').reverse().join(''));
  return makeKeyStore({
    configPath: tmpConfig(),
    encrypt: rot,
    decrypt: (b) => b.toString().split('').reverse().join(''),
    isEncryptionAvailable: () => true,
    env,
  });
}

test('set then get round-trips the key (plaintext)', () => {
  const ks = plainStore();
  ks.setKey('sk-abcdef123456');
  assert.strictEqual(ks.getStoredKey(), 'sk-abcdef123456');
});

test('set then get round-trips the key (encrypted)', () => {
  const ks = encStore();
  ks.setKey('sk-abcdef123456');
  assert.strictEqual(ks.getStoredKey(), 'sk-abcdef123456');
});

test('encrypted store does not persist the key in plaintext on disk', () => {
  const cfgPath = tmpConfig();
  const rot = (s) => Buffer.from(s.split('').reverse().join(''));
  const ks = makeKeyStore({
    configPath: cfgPath, encrypt: rot,
    decrypt: (b) => b.toString().split('').reverse().join(''),
    isEncryptionAvailable: () => true, env: {},
  });
  ks.setKey('sk-secret-value');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(!raw.includes('sk-secret-value'));
});

test('resolveKey prefers stored over env', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-from-env' });
  ks.setKey('sk-from-store');
  assert.strictEqual(ks.resolveKey(), 'sk-from-store');
});

test('resolveKey falls back to env when nothing stored', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-from-env' });
  assert.strictEqual(ks.resolveKey(), 'sk-from-env');
});

test('clearKey removes the stored key, then env is used', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-from-env' });
  ks.setKey('sk-stored');
  ks.clearKey();
  assert.strictEqual(ks.getStoredKey(), null);
  assert.strictEqual(ks.resolveKey(), 'sk-from-env');
});

test('maskKey shows only a prefix and suffix', () => {
  const ks = plainStore();
  assert.strictEqual(ks.maskKey('sk-abcdef123456'), 'sk-ab…3456');
  assert.strictEqual(ks.maskKey('short'), '****');
  assert.strictEqual(ks.maskKey(null), null);
});

test('getKeyStatus reports source and masked value', () => {
  const ks = plainStore({ DEEPSEEK_API_KEY: 'sk-environment-key' });
  assert.deepStrictEqual(ks.getKeyStatus(), { hasKey: true, source: 'env', masked: 'sk-en…-key' });
  ks.setKey('sk-stored-abcd');
  assert.deepStrictEqual(ks.getKeyStatus(), { hasKey: true, source: 'stored', masked: 'sk-st…abcd' });
  ks.clearKey();
  const empty = makeKeyStore({ configPath: tmpConfig(), encrypt: (s)=>Buffer.from(s), decrypt:(b)=>b.toString(), isEncryptionAvailable:()=>false, env:{} });
  assert.deepStrictEqual(empty.getKeyStatus(), { hasKey: false, source: 'none', masked: null });
});

test('missing/corrupt config file is treated as empty', () => {
  const ks = plainStore();
  assert.strictEqual(ks.getStoredKey(), null); // file does not exist yet
});
