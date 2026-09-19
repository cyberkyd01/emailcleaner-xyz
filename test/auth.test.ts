import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateTotpSecret,
  normaliseBackupCode,
  otpauthUri,
  totpCode,
  verifyTotp,
} from '../src/lib/totp.js';
import { PLANS, getPlan, planToJson } from '../src/services/plans.js';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const input = Buffer.from([0x00, 0x7f, 0xff, 0x10, 0xab, 0xcd, 0xef]);
    expect(base32Decode(base32Encode(input))).toEqual(input);
  });

  it('matches the RFC 4648 test vector', () => {
    // "foobar" -> MZXW6YTBOI
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
  });

  it('tolerates padding, whitespace and lower case', () => {
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YTB01')).toThrowError(/Invalid base32/);
  });
});

describe('TOTP', () => {
  it('produces a stable 6-digit code for a fixed time step', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const code = totpCode(secret, 59_000);
    expect(code).toMatch(/^\d{6}$/);
    // Same 30-second window gives the same code.
    expect(totpCode(secret, 45_000)).toBe(code);
    // Next window gives a different one.
    expect(totpCode(secret, 95_000)).not.toBe(code);
  });

  it('matches the RFC 6238 SHA-1 test vector at T=59', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, 59_000)).toBe('287082');
  });

  it('accepts the current code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(secret))).toBe(true);
  });

  it('accepts one step of clock drift either way', () => {
    const secret = generateTotpSecret();
    const now = 1_000_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), { atMs: now })).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), { atMs: now })).toBe(true);
  });

  it('rejects drift beyond the window', () => {
    const secret = generateTotpSecret();
    const now = 1_000_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now - 120_000), { atMs: now })).toBe(false);
  });

  it('rejects malformed input rather than throwing', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
  });

  it('rejects a code from a different secret', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(verifyTotp(a, totpCode(b))).toBe(false);
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'a@example.com', issuer: 'Email Cleaner' });
    expect(uri.startsWith('otpauth://totp/Email%20Cleaner%3Aa%40example.com?')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Email+Cleaner');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('recovery codes', () => {
  it('generates ten distinct codes', () => {
    const codes = generateBackupCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('avoids characters that are ambiguous when read aloud', () => {
    const joined = generateBackupCodes(40).join('');
    expect(joined).not.toMatch(/[O0I1L]/);
  });

  it('normalises formatting so users can type them loosely', () => {
    expect(normaliseBackupCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normaliseBackupCode(' ab cd e-fg hjk ')).toBe('ABCDEFGHJK');
  });
});

describe('plans', () => {
  it('exposes three plans in ascending price order', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['free', 'pro', 'business']);
    const prices = PLANS.map((p) => p.priceMonthlyCents);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it('falls back to the free plan for an unknown id', () => {
    expect(getPlan('enterprise').id).toBe('free');
  });

  it('limits increase monotonically with price', () => {
    const [free, pro, business] = PLANS;
    expect(pro!.limits.mailboxes).toBeGreaterThan(free!.limits.mailboxes);
    expect(business!.limits.mailboxes).toBeGreaterThan(pro!.limits.mailboxes);
    expect(pro!.limits.undoWindowDays).toBeGreaterThan(free!.limits.undoWindowDays);
  });

  it('only the free plan forbids scheduled rules', () => {
    expect(getPlan('free').limits.scheduledRules).toBe(0);
    expect(getPlan('pro').limits.scheduledRules).toBeGreaterThan(0);
  });

  it('serialises Infinity as null so the JSON survives the wire', () => {
    const json = planToJson(getPlan('pro'));
    expect(json.limits.jobsPerMonth).toBeNull();
    expect(JSON.parse(JSON.stringify(json)).limits.jobsPerMonth).toBeNull();
    expect(planToJson(getPlan('free')).limits.jobsPerMonth).toBe(10);
  });
});
