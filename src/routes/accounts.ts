import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { providerCatalog } from '../providers/catalog.js';
import { discoverImapSettings } from '../providers/imap/autodiscover.js';
import { ImapProvider } from '../providers/imap/adapter.js';
import {
  deleteAccount,
  getFolders,
  listAccounts,
  openProvider,
  updateProtections,
  upsertAccount,
  defaultProtections,
} from '../services/accounts.js';
import { assertCanAddMailbox } from '../services/plans.js';
import { currentUser, requireUser } from './plugin.js';

const imapConnectSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(512),
  /** Optional overrides when autodiscovery guesses wrong. */
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  /** Defaults to the email address; some hosts want a bare username. */
  username: z.string().trim().min(1).max(255).optional(),
});

const protectionsSchema = z.object({
  folders: z.array(z.string().max(500)).max(200).default([]),
  senders: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  keywords: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
});

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /** The connect UI and the docs both read from here. */
  app.get('/api/providers', async () => ({ providers: providerCatalog() }));

  /** Looks up IMAP settings for an address before asking for a password. */
  app.get('/api/providers/imap/discover', { preHandler: requireUser }, async (request) => {
    const email = (request.query as { email?: string }).email;
    if (!email) throw badRequest('Pass ?email=someone@example.com');
    const settings = await discoverImapSettings(email);
    return { settings };
  });

  app.get('/api/accounts', { preHandler: requireUser }, async (request) => ({
    accounts: await listAccounts(currentUser(request).id),
  }));

  /**
   * IMAP connect. The credential is tested against the live server before it is
   * stored, so a bad app password fails here rather than mid-clean.
   */
  app.post('/api/accounts/imap', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const parsed = imapConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid IMAP details', parsed.error.issues.map((i) => i.message));
    }
    const input = parsed.data;
    await assertCanAddMailbox(user.id);

    const discovered = await discoverImapSettings(input.email);
    const credentials = {
      host: input.host ?? discovered.host,
      port: input.port ?? discovered.port,
      secure: input.secure ?? discovered.secure,
      user: input.username ?? input.email,
      password: input.password,
    };

    const probe = new ImapProvider('probe', credentials);
    try {
      await probe.verify();
      // Listing folders also proves the account can actually be enumerated,
      // which catches hosts that authenticate but refuse IMAP access.
      await probe.listFolders();
    } finally {
      await probe.close();
    }

    const account = await upsertAccount({
      userId: user.id,
      provider: 'imap',
      authType: 'password',
      email: input.email,
      secret: { kind: 'imap', credentials },
      settings: {
        host: credentials.host,
        port: credentials.port,
        secure: credentials.secure,
        discoveredVia: input.host ? 'manual' : discovered.source,
      },
    });
    return { account, guidance: discovered.guidance ?? null };
  });

  app.get('/api/accounts/:id/folders', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const refresh = (request.query as { refresh?: string }).refresh === 'true';
    const folders = await getFolders(currentUser(request).id, id, refresh);
    return { folders };
  });

  /** Confirms stored credentials still work and reports provider capabilities. */
  app.post('/api/accounts/:id/test', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const provider = await openProvider(currentUser(request).id, id);
    try {
      const identity = await provider.verify();
      return { ok: true, identity, capabilities: provider.capabilities };
    } finally {
      await provider.close();
    }
  });

  app.put('/api/accounts/:id/protections', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = protectionsSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Invalid protections payload');
    const account = await updateProtections(currentUser(request).id, id, {
      ...defaultProtections(),
      ...parsed.data,
    });
    return { account };
  });

  app.delete('/api/accounts/:id', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteAccount(currentUser(request).id, id);
    return { ok: true };
  });
}
