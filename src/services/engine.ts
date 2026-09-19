import { matchesResidual, resolveFolders, residualIsEmpty } from '../providers/query.js';
import { PROTECTED_ROLES } from '../providers/types.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { AccountProtections } from './accounts.js';
import type {
  BulkOutcome,
  CleanQuery,
  CompiledQuery,
  DeleteMode,
  MailProvider,
  MessageRef,
  NormalizedFolder,
  ResidualFilter,
} from '../providers/types.js';

export interface CleanPlan {
  compiled: CompiledQuery;
  folders: NormalizedFolder[];
  /** Filters applied locally, including the account-level protections. */
  residual: ResidualFilter;
  /** Whether evaluating the residual needs message bodies (costly). */
  requiresBody: boolean;
  notes: string[];
  /** Conditions the user should see before confirming. */
  warnings: string[];
  /** Selectors that matched no folder on this account. */
  unmatchedSelectors: string[];
}

/**
 * Turns a rule into an executable plan: which folders, which native query, and
 * what still has to be checked locally. Nothing here touches the mailbox.
 */
export async function planClean(
  provider: MailProvider,
  query: CleanQuery,
  protections: AccountProtections,
): Promise<CleanPlan> {
  const allFolders = await provider.listFolders();
  const resolution = resolveFolders(query.folders, allFolders);

  const warnings: string[] = [];

  // Account-level folder protections beat anything a rule asks for.
  const blocked = new Set(protections.folders);
  let folders = resolution.selected.filter((f) => {
    if (blocked.has(f.remoteId)) {
      warnings.push(`"${f.path}" is protected on this account and was excluded.`);
      return false;
    }
    return true;
  });

  // A protected role reached only through an unqualified role selector is
  // dropped; naming it as folder:<id> is treated as deliberate.
  const explicitIds = new Set(
    query.folders.filter((s) => s.startsWith('folder:')).map((s) => s.slice('folder:'.length)),
  );
  folders = folders.filter((f) => {
    if ((f.isProtected || PROTECTED_ROLES.has(f.role)) && !explicitIds.has(f.remoteId) && !query.folders.includes(f.role)) {
      warnings.push(`"${f.path}" holds mail you sent or filed, so it was skipped.`);
      return false;
    }
    return true;
  });

  if (folders.length === 0) {
    throw badRequest(
      resolution.unmatched.length > 0
        ? `None of the requested folders exist on this account: ${resolution.unmatched.join(', ')}`
        : 'This query selects no folders to clean.',
    );
  }

  for (const folder of folders) {
    if (folder.isProtected || PROTECTED_ROLES.has(folder.role)) {
      warnings.push(`You explicitly included "${folder.path}", which normally holds mail worth keeping.`);
    }
  }
  if (resolution.unmatched.length > 0) {
    warnings.push(
      `These folders do not exist on this provider and were ignored: ${resolution.unmatched.join(', ')}.`,
    );
  }

  const compiled = provider.compile(query, folders);

  // Fold account protections into the residual so they are enforced on every
  // candidate regardless of what the provider query did.
  const residual: ResidualFilter = { ...compiled.residual };
  if (protections.senders.length > 0) {
    residual.excludeFrom = [...(residual.excludeFrom ?? []), ...protections.senders];
  }
  if (protections.keywords.length > 0) {
    residual.excludeKeywords = [...(residual.excludeKeywords ?? []), ...protections.keywords];
  }
  if (query.excludeStarred) residual.excludeStarred = true;

  const requiresBody = Boolean(
    (residual.keywords && residual.keywords.scope === 'anywhere') ||
      (residual.excludeKeywords && residual.excludeKeywords.length > 0),
  );
  if (requiresBody) {
    residual.requiresBody = true;
    warnings.push(
      'Some keyword rules must be checked against message bodies, which makes this run slower and heavier on the provider.',
    );
  }

  return {
    compiled,
    folders,
    residual,
    requiresBody,
    notes: compiled.notes,
    warnings,
    unmatchedSelectors: resolution.unmatched,
  };
}

export interface MatchBatch {
  refs: MessageRef[];
  /** Candidates examined so far, including ones the residual filter rejected. */
  scanned: number;
  /** Candidates that survived every filter so far. */
  matched: number;
}

export interface StreamOptions {
  signal?: AbortSignal | undefined;
  /** Stop after this many confirmed matches. */
  limit?: number | undefined;
  /** Hydrate at least this many matches with display metadata. */
  hydrateAtLeast?: number;
  onProgress?: (scanned: number, matched: number) => void;
}

/**
 * Streams confirmed matches. Every candidate the provider returns is re-checked
 * against the residual filter before it is emitted, so a message is only ever
 * deleted when this process can prove it matched.
 */
export async function* streamMatches(
  provider: MailProvider,
  plan: CleanPlan,
  opts: StreamOptions = {},
): AsyncGenerator<MatchBatch> {
  const needsFilter = !residualIsEmpty(plan.residual);
  const hydrateAtLeast = opts.hydrateAtLeast ?? 0;

  let scanned = 0;
  let matched = 0;

  for await (const page of provider.search(plan.compiled, {
    signal: opts.signal,
    onProgress: () => undefined,
  })) {
    if (opts.signal?.aborted) return;
    scanned += page.length;

    let candidates = page;

    if (needsFilter) {
      // A local filter has to be evaluated against every candidate, so the
      // whole page is hydrated.
      candidates = await provider.hydrate(page, { body: plan.requiresBody });
    } else if (matched < hydrateAtLeast) {
      // Nothing needs filtering — these fetches exist only to fill the preview
      // sample. Hydrating the whole page to display 25 rows costs 20x more
      // provider quota than it should and is what trips Gmail's per-second
      // limit on large folders, so fetch exactly the shortfall.
      const shortfall = Math.min(hydrateAtLeast - matched, page.length);
      const head = await provider.hydrate(page.slice(0, shortfall), { body: false });
      candidates = head.concat(page.slice(shortfall));
    }

    const survivors = needsFilter
      ? candidates.filter((ref) => matchesResidual(ref, plan.residual))
      : candidates;

    if (needsFilter && survivors.length < candidates.length) {
      logger.debug('residual filter rejected candidates', {
        rejected: candidates.length - survivors.length,
        of: candidates.length,
      });
    }

    let emit = survivors;
    if (opts.limit !== undefined && matched + emit.length > opts.limit) {
      emit = emit.slice(0, opts.limit - matched);
    }
    matched += emit.length;

    if (emit.length > 0) {
      opts.onProgress?.(scanned, matched);
      yield { refs: emit, scanned, matched };
    }

    if (opts.limit !== undefined && matched >= opts.limit) return;
  }

  // Report the final tally even when the last page produced no matches.
  opts.onProgress?.(scanned, matched);
}

export interface FolderTally {
  remoteId: string;
  path: string;
  role: string;
  matched: number;
  bytes: number;
}

export interface PreviewResult {
  matched: number;
  scanned: number;
  bytes: number;
  /** Per-folder breakdown so the user sees where the damage would land. */
  byFolder: FolderTally[];
  /** Newest matches, hydrated for display. */
  sample: MessageRef[];
  /** True when enumeration stopped at the tracking cap. */
  truncated: boolean;
  plan: CleanPlan;
}

/** Counts matches without mutating anything. This is what "dry run" means here. */
export async function previewClean(
  provider: MailProvider,
  plan: CleanPlan,
  opts: { signal?: AbortSignal; sampleSize?: number; cap: number; onProgress?: (scanned: number, matched: number) => void },
): Promise<PreviewResult> {
  const sampleSize = opts.sampleSize ?? 25;
  const tallies = new Map<string, FolderTally>();
  for (const folder of plan.folders) {
    tallies.set(folder.remoteId, {
      remoteId: folder.remoteId,
      path: folder.path,
      role: folder.role,
      matched: 0,
      bytes: 0,
    });
  }

  const sample: MessageRef[] = [];
  let matched = 0;
  let scanned = 0;
  let bytes = 0;
  let truncated = false;

  for await (const batch of streamMatches(provider, plan, {
    signal: opts.signal,
    limit: opts.cap,
    hydrateAtLeast: sampleSize,
    onProgress: opts.onProgress,
  })) {
    scanned = batch.scanned;
    matched = batch.matched;
    for (const ref of batch.refs) {
      const tally = tallies.get(ref.folderRemoteId ?? '');
      if (tally) {
        tally.matched++;
        tally.bytes += ref.sizeBytes ?? 0;
      }
      bytes += ref.sizeBytes ?? 0;
      if (sample.length < sampleSize) sample.push(ref);
    }
    if (matched >= opts.cap) {
      truncated = true;
      break;
    }
  }

  return {
    matched,
    scanned,
    bytes,
    byFolder: [...tallies.values()].filter((t) => t.matched > 0).sort((a, b) => b.matched - a.matched),
    sample,
    truncated,
    plan,
  };
}

export interface DeleteProgress {
  deleted: number;
  failed: number;
}

/**
 * Deletes a set of already-confirmed matches. Kept separate from matching so
 * the executor can replay ids recorded at preview time rather than re-searching
 * a mailbox that may have changed.
 */
export async function deleteRefs(
  provider: MailProvider,
  refs: MessageRef[],
  mode: DeleteMode,
  onProgress?: (p: DeleteProgress) => void,
): Promise<BulkOutcome> {
  if (refs.length === 0) return { succeeded: [], failed: [] };
  const outcome = await provider.delete(refs, mode);
  onProgress?.({ deleted: outcome.succeeded.length, failed: outcome.failed.length });
  return outcome;
}
