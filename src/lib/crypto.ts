import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Secret-at-rest encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_VERSION = 'v1';

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!config.encryptionKey) {
    throw new Error('ENCRYPTION_KEY is not set — run `npm run keygen` and put it in .env');
  }
  const key = Buffer.from(config.encryptionKey, 'base64');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length})`);
  }
  cachedKey = key;
  return key;
}

/**
 * Encrypts a secret for storage. `aad` binds the ciphertext to its row so a
 * token copied into another account's record fails to decrypt.
 * Output: v1.<iv>.<authTag>.<ciphertext>, all base64url.
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [KEY_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, aad?: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== KEY_VERSION) {
    throw new Error('Malformed encrypted payload');
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(ivB64, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Encrypt a JSON-serialisable credential blob. */
export const encryptJson = (value: unknown, aad?: string): string =>
  encryptSecret(JSON.stringify(value), aad);

export const decryptJson = <T>(payload: string, aad?: string): T =>
  JSON.parse(decryptSecret(payload, aad)) as T;

// ---------------------------------------------------------------------------
// Password hashing (scrypt — no native build step)
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const constantTimeEquals = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};
