import { createConnection, type Socket } from 'node:net';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Minimal SMTP submission client.
 *
 * The service runs on the same host as Postfix, which accepts unauthenticated
 * submission from 127.0.0.1, so there is nothing to negotiate: no TLS, no SASL,
 * no MIME multipart. That makes a ~100-line client the right call over a
 * dependency — and keeps outbound notification mail on the same DKIM-signed
 * path as everything else the server sends.
 */

export interface OutgoingMail {
  to: string;
  subject: string;
  /** Plain text. Encoded as base64 so 8-bit content and leading dots are safe. */
  text: string;
  replyTo?: string | undefined;
  from?: string | undefined;
}

class SmtpError extends Error {}

function readReply(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // A reply is complete when the last line is "NNN " rather than "NNN-".
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer.trim());
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => onError(new SmtpError('SMTP read timed out')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(socket: Socket, line: string | null, expect: number, timeoutMs: number): Promise<string> {
  if (line !== null) socket.write(`${line}\r\n`);
  const reply = await readReply(socket, timeoutMs);
  const code = Number.parseInt(reply.slice(0, 3), 10);
  if (Math.floor(code / 100) !== Math.floor(expect / 100)) {
    throw new SmtpError(`SMTP: expected ${expect}, got "${reply.split('\r\n')[0]}"`);
  }
  return reply;
}

/** RFC 2047 encoding, so non-ASCII subjects do not arrive as mojibake. */
const encodeHeader = (value: string): string =>
  /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

const foldBase64 = (input: string): string =>
  (Buffer.from(input, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const from = mail.from ?? config.mail.from;
  const timeout = 15_000;

  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection({ host: config.mail.host, port: config.mail.port });
    s.setTimeout(timeout);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
    s.once('timeout', () => {
      s.destroy();
      reject(new SmtpError('SMTP connect timed out'));
    });
  });

  try {
    await command(socket, null, 220, timeout); // greeting
    await command(socket, `EHLO ${config.mail.heloName}`, 250, timeout);
    await command(socket, `MAIL FROM:<${from}>`, 250, timeout);
    await command(socket, `RCPT TO:<${mail.to}>`, 250, timeout);
    await command(socket, 'DATA', 354, timeout);

    const headers = [
      `From: ${encodeHeader(config.brand.name)} <${from}>`,
      `To: <${mail.to}>`,
      mail.replyTo ? `Reply-To: <${mail.replyTo}>` : null,
      `Subject: ${encodeHeader(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${config.mail.heloName}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      'Auto-Submitted: auto-generated',
    ].filter(Boolean);

    socket.write(`${headers.join('\r\n')}\r\n\r\n${foldBase64(mail.text)}\r\n`);
    await command(socket, '.', 250, timeout);
    await command(socket, 'QUIT', 221, timeout).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

/**
 * Fire-and-forget wrapper. A notification that fails to send must never fail
 * the request that triggered it — the submission is already saved.
 */
export function sendMailSafely(mail: OutgoingMail, context: Record<string, unknown> = {}): void {
  if (!config.mail.enabled) {
    logger.debug('outbound mail disabled, skipping notification', context);
    return;
  }
  sendMail(mail).catch((err) => {
    logger.error('notification email failed', { ...context, to: mail.to, error: (err as Error).message });
  });
}
