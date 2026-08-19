import type { DB } from './db.js';
import { monthlySpendMicros } from '../agents/_client.js';
import { sendTelegram } from '../tools/telegram.js';

export interface HeartbeatDeps {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface HeartbeatStats {
  alerts: string[];
  allGreenSent: boolean;
  sent: boolean;
}

const STALE_HOURS = 48;
const WATCHDOG_HOURS = 25;
const WATCHDOG_KINDS = ['export', 'backup'] as const;

interface StaleSource { url: string; last_ok: string | null }
interface DegradedSource { url: string; degraded_reason: string }
interface LatestRun { state: string; ended_at: string | null; error: string | null }

/**
 * Spec 15.3: outcome-based, not mechanism-based — each check asserts on what
 * an operator actually cares about (a source that stopped reporting, a
 * publish/backup that failed) rather than on how the pipeline is wired.
 * Silence means healthy; the weekly all-green line makes a dead Telegram
 * channel itself detectable.
 */
export async function runHeartbeat(db: DB, deps: HeartbeatDeps = {}): Promise<HeartbeatStats> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const nowIso = now().toISOString();
  const alerts: string[] = [];

  // Both sides go through datetime() deliberately — see the identical guard
  // (and comment) in src/workflow/collect.ts: we store ISO 8601 with a 'T'
  // and 'Z', sqlite's datetime() emits a space and no zone, and a raw string
  // compare would let 'T' > ' ' decide same-day ties.
  const stale = db.prepare(`
    SELECT s.url AS url,
      (SELECT MAX(snap.fetched_at) FROM snapshots snap
       WHERE snap.source_id = s.id AND snap.ok = 1) AS last_ok
    FROM sources s
    WHERE s.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM snapshots snap
        WHERE snap.source_id = s.id AND snap.ok = 1
          AND datetime(snap.fetched_at) > datetime(?, '-${STALE_HOURS} hours')
      )
    ORDER BY s.id
  `).all(nowIso) as StaleSource[];

  if (stale.length > 0) {
    alerts.push(
      `Stale sources (no successful check in ${STALE_HOURS}h): ` +
      stale.map(s => `${s.url} (last ok: ${s.last_ok ?? 'never'})`).join('; '),
    );
  }

  const degraded = db.prepare(`
    SELECT url, degraded_reason FROM sources
    WHERE active = 1 AND degraded_reason IS NOT NULL
    ORDER BY id
  `).all() as DegradedSource[];

  if (degraded.length > 0) {
    alerts.push(
      'Degraded sources: ' +
      degraded.map(s => `${s.url} (${s.degraded_reason})`).join('; '),
    );
  }

  const latestRunOfKind = db.prepare(
    'SELECT state, ended_at, error FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1'
  );
  const withinWatchdogWindow = db.prepare(
    `SELECT datetime(?) > datetime(?, '-${WATCHDOG_HOURS} hours') AS within_window`
  );
  for (const kind of WATCHDOG_KINDS) {
    const latest = latestRunOfKind.get(kind) as LatestRun | undefined;
    if (!latest || latest.state !== 'failed' || !latest.ended_at) continue;
    const within = withinWatchdogWindow.get(latest.ended_at, nowIso) as { within_window: number };
    if (within.within_window) {
      alerts.push(`${kind} failed at ${latest.ended_at}: ${latest.error ?? 'unknown error'}`);
    }
  }

  if (alerts.length > 0) {
    const message = `Bellwether: ${alerts.length} problem(s)\n` + alerts.join('\n');
    const result = await sendTelegram(message, { env, fetchImpl: deps.fetchImpl });
    return { alerts, allGreenSent: false, sent: result.sent };
  }

  // Spec 13's Monday-in-CT gate reused verbatim (see the identical comment
  // in src/workflow/synthesize.ts): the container runs at 07:00 CT, so a
  // UTC weekday check would misclassify a late-Sunday-CT or early-Monday-CT run.
  const weekdayCT = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Chicago' }).format(now());
  if (weekdayCT !== 'Mon') {
    return { alerts, allGreenSent: false, sent: false };
  }

  const total = (db.prepare('SELECT COUNT(*) AS n FROM sources WHERE active = 1').get() as { n: number }).n;
  const lastPublish = (db.prepare(
    "SELECT ended_at FROM runs WHERE kind = 'export' AND state = 'ok' ORDER BY id DESC LIMIT 1"
  ).get() as { ended_at: string } | undefined)?.ended_at ?? 'never';
  const spendMicros = monthlySpendMicros(db, now());

  const message = `all green: ${total}/${total} sources healthy, last publish ${lastPublish}, ` +
    `spend this month $${(spendMicros / 1e6).toFixed(2)}`;
  const result = await sendTelegram(message, { env, fetchImpl: deps.fetchImpl });

  return { alerts, allGreenSent: result.sent, sent: result.sent };
}
