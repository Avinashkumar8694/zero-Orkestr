// Dual-tier RSA cryptographic engine:
// 1. In-Transit: Ephemeral 2048-bit RSA-OAEP key pair generated on every server startup in memory.
//    Frontend fetches the public key and encrypts sensitive fields before HTTP transmission.
// 2. At-Rest: Persistent 2048-bit RSA-OAEP key pair configured via SECRETS_ENCRYPTION_PRIVATE_KEY / PUBLIC_KEY
//    env variables (or auto-provisioned securely into config.dataDir). Encrypts secrets in database rows.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

const IN_TRANSIT_PREFIX = 'enc:rsa:oaep:';
const AT_REST_PREFIX = 'dbenc:rsa:';

// ── 1. Ephemeral In-Transit RSA Key Pair (Regenerated on every server restart) ──
let ephemeralKeyPair: { publicKey: string; privateKey: string };

function initEphemeralKeys(): { publicKey: string; privateKey: string } {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

ephemeralKeyPair = initEphemeralKeys();

/** Exposes the in-transit ephemeral public key for frontend clients */
export function getEphemeralPublicKey(): string {
  return ephemeralKeyPair.publicKey;
}

/** Forces regeneration of the in-transit ephemeral key pair (e.g. for testing) */
export function regenerateEphemeralKeys(): void {
  ephemeralKeyPair = initEphemeralKeys();
}

/** Decrypts a sensitive string sent from UI if it was RSA encrypted in-transit */
export function decryptInTransit(ciphertext: string | undefined | null): string | undefined {
  if (ciphertext === undefined || ciphertext === null) return undefined;
  const str = String(ciphertext).trim();
  if (!str) return '';

  if (!str.startsWith(IN_TRANSIT_PREFIX)) {
    // If not prefixed with the marker, assume legacy plaintext (keeps test suites & existing calls working)
    return str;
  }

  const rawBase64 = str.slice(IN_TRANSIT_PREFIX.length).trim();
  try {
    const buffer = Buffer.from(rawBase64, 'base64');
    const decrypted = crypto.privateDecrypt(
      {
        key: ephemeralKeyPair.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer
    );
    return decrypted.toString('utf8');
  } catch (err: any) {
    throw new Error(`Failed to decrypt in-transit payload: ${err.message}`);
  }
}

// ── 2. At-Rest RSA Key Management (Environment Variable or Persistent Keystore) ──
let atRestKeyPair: { publicKey: string; privateKey: string };

function initAtRestKeys(): { publicKey: string; privateKey: string } {
  const envPriv = process.env.SECRETS_ENCRYPTION_PRIVATE_KEY;
  const envPub = process.env.SECRETS_ENCRYPTION_PUBLIC_KEY;

  if (envPriv && envPub) {
    return {
      publicKey: envPub.replace(/\\n/g, '\n'),
      privateKey: envPriv.replace(/\\n/g, '\n'),
    };
  }

  // Fallback to persisted key file in data directory
  const keyDir = path.resolve(config.dataDir, '.secrets');
  const privPath = path.join(keyDir, 'secrets_rsa_priv.pem');
  const pubPath = path.join(keyDir, 'secrets_rsa_pub.pem');

  try {
    if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
      return {
        publicKey: fs.readFileSync(pubPath, 'utf8'),
        privateKey: fs.readFileSync(privPath, 'utf8'),
      };
    }

    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const generated = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    fs.writeFileSync(privPath, generated.privateKey, { mode: 0o600 });
    fs.writeFileSync(pubPath, generated.publicKey, { mode: 0o644 });
    return generated;
  } catch {
    // If filesystem not writable, generate in-memory
    return crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
}

atRestKeyPair = initAtRestKeys();

/** Encrypts a sensitive string before persisting it to the database */
export function encryptAtRest(plaintext: string | undefined | null): string | undefined {
  if (plaintext === undefined || plaintext === null) return undefined;
  const str = String(plaintext);
  if (!str) return '';
  if (str.startsWith(AT_REST_PREFIX)) return str; // already encrypted

  const buffer = Buffer.from(str, 'utf8');
  const encrypted = crypto.publicEncrypt(
    {
      key: atRestKeyPair.publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    buffer
  );
  return `${AT_REST_PREFIX}${encrypted.toString('base64')}`;
}

/** Decrypts a sensitive string stored encrypted in the database when needed in memory */
export function decryptAtRest(ciphertext: string | undefined | null): string | undefined {
  if (ciphertext === undefined || ciphertext === null) return undefined;
  const str = String(ciphertext);
  if (!str) return '';
  if (!str.startsWith(AT_REST_PREFIX)) return str; // not encrypted (or legacy)

  const rawBase64 = str.slice(AT_REST_PREFIX.length).trim();
  try {
    const buffer = Buffer.from(rawBase64, 'base64');
    const decrypted = crypto.privateDecrypt(
      {
        key: atRestKeyPair.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer
    );
    return decrypted.toString('utf8');
  } catch (err: any) {
    throw new Error(`Failed to decrypt at-rest secret: ${err.message}`);
  }
}
