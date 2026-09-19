import { randomBytes } from 'node:crypto';

/** Prints the two secrets a deployment needs. Never reuse them across environments. */
const line = (name: string, bytes: number) => `${name}=${randomBytes(bytes).toString('base64')}`;

process.stdout.write(
  [
    '# Copy these into your .env (keep them out of version control).',
    '# Changing ENCRYPTION_KEY makes every stored credential unreadable.',
    line('ENCRYPTION_KEY', 32),
    line('SESSION_SECRET', 48),
    '',
  ].join('\n'),
);
