const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function decryptCredential(bytes, dataDir, native) {
  const prefix = bytes.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') {
    return native('decrypt', { bytes: bytes.toString('base64') });
  }
  const localState = JSON.parse(fs.readFileSync(path.join(dataDir, 'Local State'), 'utf8'));
  const wrappedKey = Buffer.from(localState.os_crypt.encrypted_key, 'base64');
  if (wrappedKey.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('旧版登录凭证格式不受支持，请在同步设置中重新登录。');
  }
  const key = Buffer.from(native('unprotect', { bytes: wrappedKey.subarray(5).toString('base64') }), 'base64');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(3, 15));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]).toString('utf8');
  } finally {
    key.fill(0);
  }
}

module.exports = { decryptCredential };
