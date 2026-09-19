import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) over HMAC-SHA1 with 6 digits and a 30-second step — the
 * combination every authenticator app assumes. Implemented directly because the
 * algorithm is thirty lines and a dependency here would sit on the auth path.
 */

const DIGITS = 6;
const PERIOD = 30;
const ALGORITHM = 'sha1';

// RFC 4648 base32, which is what otpauth:// URIs carry.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20 bytes = 160 bits, the SHA-1 block size RFC 4226 recommends. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(ALGORITHM, secret).update(buf).digest();
  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const totpCode = (secretBase32: string, atMs = Date.now()): string =>
  hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / PERIOD));

/**
 * Verifies a submitted code, allowing `window` steps of clock drift either way.
 * One step (±30s) is the usual compromise between phone clock skew and the
 * attacker's guessing window.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: { window?: number; atMs?: number } = {},
): boolean {
  const code = token.replace(/\D/g, '');
  if (code.length !== DIGITS) return false;

  const window = opts.window ?? 1;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor((opts.atMs ?? Date.now()) / 1000 / PERIOD);

  let matched = false;
  // Check every step in the window rather than returning early, so the time
  // taken does not reveal which step matched.
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(hotp(secret, counter + drift));
    const actual = Buffer.from(code);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) matched = true;
  }
  return matched;
}

/** otpauth:// URI that authenticator apps consume from a QR code. */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Crockford-ish alphabet: no 0/O/1/I/L, so codes survive being read aloud. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    for (let c = 0; c < 10; c++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

export const normaliseBackupCode = (code: string): string =>
  code.toUpperCase().replace(/[^0-9A-Z]/g, '');
