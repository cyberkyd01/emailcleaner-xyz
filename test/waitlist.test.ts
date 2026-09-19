import { describe, expect, it } from 'vitest';
import { interestSchema } from '../src/services/waitlist.js';

describe('interest form validation', () => {
  it('accepts a minimal submission', () => {
    const r = interestSchema.safeParse({ email: 'someone@example.com' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.plan).toBe('undecided');
  });

  it('normalises the email', () => {
    const r = interestSchema.parse({ email: '  Someone@Example.COM ' });
    expect(r.email).toBe('someone@example.com');
  });

  it('rejects a malformed email', () => {
    expect(interestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('requires an email at all', () => {
    expect(interestSchema.safeParse({ name: 'Nobody' }).success).toBe(false);
  });

  it('only allows known plans', () => {
    expect(interestSchema.safeParse({ email: 'a@b.com', plan: 'pro' }).success).toBe(true);
    expect(interestSchema.safeParse({ email: 'a@b.com', plan: 'enterprise' }).success).toBe(false);
  });

  it('only allows known mailbox bands', () => {
    expect(interestSchema.safeParse({ email: 'a@b.com', mailboxes: '2-5' }).success).toBe(true);
    expect(interestSchema.safeParse({ email: 'a@b.com', mailboxes: 'loads' }).success).toBe(false);
  });

  it('caps free-text so the form cannot be used to send an essay', () => {
    expect(interestSchema.safeParse({ email: 'a@b.com', message: 'x'.repeat(2001) }).success).toBe(false);
    expect(interestSchema.safeParse({ email: 'a@b.com', message: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('rejects unknown fields rather than silently storing them', () => {
    expect(interestSchema.safeParse({ email: 'a@b.com', isAdmin: true }).success).toBe(false);
  });

  it('carries the honeypot field so the server can spot bots', () => {
    const r = interestSchema.parse({ email: 'a@b.com', website: 'http://spam.example' });
    expect(r.website).toBe('http://spam.example');
  });
});
