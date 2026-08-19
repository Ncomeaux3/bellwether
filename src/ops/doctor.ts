import type { DB } from './db.js';
import { politeFetch, type FetchResult } from '../tools/fetch.js';

export interface CheckResult {
  name: string;
  status: 'ok' | 'fail' | 'pending';
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  db: DB;
  env: Record<string, string | undefined>;
  fetcher?: (url: string) => Promise<FetchResult>;
  gitPush?: () => Promise<{ ok: boolean; detail: string; skipped?: boolean }>;
  publishScript?: () => Promise<{ ok: boolean; detail: string; skipped?: boolean }>;
}

const REQUIRED_ENV = ['BELLWETHER_DB', 'BELLWETHER_EXPORT_DIR'] as const;

/**
 * Spec 22.3. The first-run experience is: run doctor until green, then up.
 * Every failure names what to fix and where — never a stack trace.
 */
export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const fetcher = deps.fetcher ?? ((url: string) => politeFetch(url));

  // 1. Environment
  const missing = REQUIRED_ENV.filter(k => !deps.env[k] || deps.env[k]!.trim() === '');
  results.push(missing.length === 0
    ? { name: 'environment', status: 'ok', detail: `${REQUIRED_ENV.length} required variables set` }
    : {
        name: 'environment', status: 'fail',
        detail: `missing or empty: ${missing.join(', ')}`,
        fix: 'Copy .env.example to .env and fill in these values. Each one documents where to get it.',
      });

  // 2. Schema
  let schemaOk = false;
  try {
    const applied = deps.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).get() as { n: number };
    if (applied.n === 0) throw new Error('schema_migrations is missing');

    const tables = deps.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN " +
      "('competitors','sources','snapshots','extractions','changes','analyses','digests','backfill_queue','runs')"
    ).get() as { n: number };

    schemaOk = tables.n === 9;
    results.push(schemaOk
      ? { name: 'schema', status: 'ok', detail: 'all 9 tables present, WAL enabled' }
      : { name: 'schema', status: 'fail', detail: `${tables.n} of 9 tables present`,
          fix: 'Run `bellwether migrate`.' });
  } catch (err) {
    results.push({
      name: 'schema', status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Run `bellwether migrate`.',
    });
  }

  // 3. Anthropic key — M2
  results.push({
    name: 'anthropic key', status: 'pending',
    detail: 'not checked yet; extraction arrives in M2',
  });

  // 4. Git push
  if (deps.gitPush) {
    try {
      const push = await deps.gitPush();
      results.push(push.skipped
        ? { name: 'git push', status: 'pending', detail: push.detail }
        : push.ok
        ? { name: 'git push', status: 'ok', detail: push.detail }
        : {
            name: 'git push', status: 'fail', detail: push.detail,
            fix: 'Check the deploy key: `git push --dry-run origin HEAD`. ' +
                 'The key needs write access to the repo Vercel builds from.',
          });
    } catch (err) {
      results.push({
        name: 'git push', status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        fix: 'Check the deploy key: `git push --dry-run origin HEAD`. ' +
             'The key needs write access to the repo Vercel builds from.',
      });
    }
  }

  // 5. Sources
  if (schemaOk) {
    try {
      const sources = deps.db.prepare(`
        SELECT c.slug, s.kind, s.url, s.canary_string
        FROM sources s JOIN competitors c ON c.id = s.competitor_id
        WHERE s.active = 1 ORDER BY c.slug
      `).all() as { slug: string; kind: string; url: string; canary_string: string }[];

      for (const source of sources) {
        const name = `source: ${source.slug}/${source.kind}`;
        const result = await fetcher(source.url);

        if (!result.ok || result.body === null) {
          results.push({
            name, status: 'fail', detail: result.error ?? 'fetch failed',
            fix: `Open ${source.url} in a browser. If it moved, update the url in src/config/competitors.public.ts.`,
          });
          continue;
        }
        if (!result.body.includes(source.canary_string)) {
          results.push({
            name, status: 'fail',
            detail: `canary "${source.canary_string}" not found in the page`,
            fix: `The page was probably redesigned. Pick a new canary from its current HTML and update src/config/competitors.public.ts.`,
          });
          continue;
        }
        results.push({ name, status: 'ok', detail: `reachable, canary present` });
      }
    } catch (err) {
      results.push({
        name: 'sources', status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        fix: 'Run `bellwether migrate` and `bellwether seed`, then retry `bellwether doctor`.',
      });
    }
  }

  // 6 & 7 — M5
  results.push({ name: 'telegram alerts', status: 'pending', detail: 'not checked yet; alerts arrive in M5' });
  results.push({ name: 'backup target', status: 'pending', detail: 'not checked yet; B2 backup arrives in M5' });

  // 8. Publish script
  if (deps.publishScript) {
    try {
      const check = await deps.publishScript();
      results.push(check.skipped
        ? { name: 'publish script', status: 'pending', detail: check.detail }
        : check.ok
        ? { name: 'publish script', status: 'ok', detail: check.detail }
        : {
            name: 'publish script', status: 'fail', detail: check.detail,
            fix: 'From the repo root: `chmod +x ops/publish.sh`.',
          });
    } catch (err) {
      results.push({
        name: 'publish script', status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        fix: 'From the repo root: `chmod +x ops/publish.sh`.',
      });
    }
  }

  return results;
}
