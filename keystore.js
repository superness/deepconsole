const fs = require('fs');
const path = require('path');

function makeKeyStore({ configPath, encrypt, decrypt, isEncryptionAvailable, env }) {
  function readConfig() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { return {}; }
  }
  function writeConfig(obj) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
  }
  function setKey(key) {
    const cfg = readConfig();
    if (isEncryptionAvailable()) {
      cfg.deepseekKeyEnc = Buffer.from(encrypt(key)).toString('base64');
      delete cfg.deepseekKey;
    } else {
      cfg.deepseekKey = key;
      delete cfg.deepseekKeyEnc;
    }
    writeConfig(cfg);
  }
  function getStoredKey() {
    const cfg = readConfig();
    if (cfg.deepseekKeyEnc) {
      try { return decrypt(Buffer.from(cfg.deepseekKeyEnc, 'base64')); }
      catch { return null; }
    }
    return cfg.deepseekKey || null;
  }
  function clearKey() {
    const cfg = readConfig();
    delete cfg.deepseekKey;
    delete cfg.deepseekKeyEnc;
    writeConfig(cfg);
  }
  function resolveKey() {
    return getStoredKey() || (env && env.DEEPSEEK_API_KEY) || null;
  }
  function maskKey(key) {
    if (!key) return null;
    if (key.length <= 8) return '****';
    return key.slice(0, 5) + '…' + key.slice(-4);
  }
  function getKeyStatus() {
    const stored = getStoredKey();
    const resolved = resolveKey();
    return {
      hasKey: !!resolved,
      source: stored ? 'stored' : (resolved ? 'env' : 'none'),
      masked: maskKey(resolved),
    };
  }
  return { setKey, getStoredKey, clearKey, resolveKey, maskKey, getKeyStatus };
}

module.exports = { makeKeyStore };
