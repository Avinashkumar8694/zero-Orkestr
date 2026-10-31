import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  getEphemeralPublicKey,
  regenerateEphemeralKeys,
  decryptInTransit,
  encryptAtRest,
  decryptAtRest,
} from '../src/infra/crypto.ts';

test('Crypto: in-transit ephemeral RSA-OAEP encryption and decryption', async () => {
  const pubPem = getEphemeralPublicKey();
  assert.ok(pubPem.includes('BEGIN PUBLIC KEY'), 'Public key must be SPKI PEM format');

  // Encrypt with public key using RSA-OAEP and SHA-256
  const secret = 'OmniAdmin@SecurePassword2026!';
  const encryptedBuf = crypto.publicEncrypt(
    {
      key: pubPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(secret, 'utf8')
  );

  const payload = `enc:rsa:oaep:${encryptedBuf.toString('base64')}`;

  // Decrypt on backend
  const decrypted = decryptInTransit(payload);
  assert.equal(decrypted, secret, 'Decrypted text should match original secret');

  // Plaintext passthrough works for backwards compatibility
  assert.equal(decryptInTransit('plain-password-123'), 'plain-password-123');
  assert.equal(decryptInTransit(undefined), undefined);

  // Key regeneration produces new ephemeral key pair
  const oldKey = getEphemeralPublicKey();
  regenerateEphemeralKeys();
  const newKey = getEphemeralPublicKey();
  assert.notEqual(oldKey, newKey, 'Regenerating keys must produce a new key');
});

test('Crypto: at-rest RSA persistent encryption and decryption', async () => {
  const secret = 'smtp-top-secret-token-xyz-123';
  const encrypted = encryptAtRest(secret);
  assert.ok(encrypted?.startsWith('dbenc:rsa:'), 'At-rest encrypted string must have prefix dbenc:rsa:');
  assert.notEqual(encrypted, secret, 'Encrypted string must not be plaintext');

  const decrypted = decryptAtRest(encrypted);
  assert.equal(decrypted, secret, 'Decrypted at-rest secret must match original');

  // Calling encryptAtRest on already-encrypted string is idempotent
  assert.equal(encryptAtRest(encrypted), encrypted);
  // Non-encrypted string returns as-is on decryptAtRest
  assert.equal(decryptAtRest('legacy-plain-secret'), 'legacy-plain-secret');
});
