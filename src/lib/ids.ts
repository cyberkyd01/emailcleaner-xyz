import { randomBytes, randomUUID } from 'node:crypto';

/** Short, URL-safe, sortable-ish id: <ms-since-epoch base36>_<random>. */
export function newId(prefix?: string): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(8).toString('base64url');
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}

export const uuid = (): string => randomUUID();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
