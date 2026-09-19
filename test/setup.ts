import { randomBytes } from 'node:crypto';

// Deterministic-length throwaway keys. Never reuse a real deployment key here.
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(48).toString('base64');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite:./data/test.sqlite';
