import { resolve } from 'node:path';
import type { DB } from '../ops/db.js';
import { collect as collectDefault } from './collect.js';
import { extract as extractDefault } from './extract.js';
import { detect as detectDefault } from './detect.js';
import { synthesize as synthesizeDefault } from './synthesize.js';
import { exportData as exportDefault } from './export.js';

export type PipelineOptions = Record<string, never>;

export interface PipelineStep { name: string; ok: boolean; summary: string }
export interface PipelineStats { steps: PipelineStep[] }

export interface PipelineDeps {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  heartbeat?: (db: DB) => Promise<unknown>;
  collectFn?: typeof collectDefault;
  extractFn?: typeof extractDefault;
  detectFn?: typeof detectDefault;
  synthesizeFn?: typeof synthesizeDefault;
  exportFn?: typeof exportDefault;
}

function firstLineOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0]!;
}

/**
 * The one daily sequence (M5 task 1): collect -> extract -> detect ->
 * synthesize -> export -> heartbeat. Cron previously ran only collect+export
 * directly, silently skipping extract/detect/synthesize every day — this
 * function is now the single place that owns the order.
 *
 * Each step runs in its own try/catch and a failure never stops the ones
 * after it (generalizes the M4 fix that wrapped only synthesize) — a
 * transient LLM failure must never cost the purely-local export. This
 * function itself never throws; failures are reported in the returned steps.
 */
export async function runPipeline(
  db: DB,
  _opts: PipelineOptions = {},
  deps: PipelineDeps = {},
): Promise<PipelineStats> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const collectFn = deps.collectFn ?? collectDefault;
  const extractFn = deps.extractFn ?? extractDefault;
  const detectFn = deps.detectFn ?? detectDefault;
  const synthesizeFn = deps.synthesizeFn ?? synthesizeDefault;
  const exportFn = deps.exportFn ?? exportDefault;

  const steps: PipelineStep[] = [];

  try {
    const s = await collectFn(db, {}, { now });
    steps.push({
      name: 'collect', ok: true,
      summary: `Checked ${s.attempted}: ${s.stored} new, ${s.unchanged} unchanged, ` +
        `${s.failed} failed, ${s.degraded} degraded, ${s.cleared} recovered.`,
    });
  } catch (err) {
    steps.push({ name: 'collect', ok: false, summary: firstLineOf(err) });
  }

  try {
    const s = await extractFn(db, {}, { now, env });
    steps.push({
      name: 'extract', ok: true,
      summary: `Extracted ${s.extracted}, cached ${s.cached}, skipped ${s.skipped}, ` +
        `degraded ${s.degraded}, historical failed ${s.historicalFailed}.`,
    });
  } catch (err) {
    steps.push({ name: 'extract', ok: false, summary: firstLineOf(err) });
  }

  try {
    const s = detectFn(db, {}, { now });
    steps.push({
      name: 'detect', ok: true,
      summary: `Detected ${s.created} changes, ${s.confirmed} confirmed.`,
    });
  } catch (err) {
    steps.push({ name: 'detect', ok: false, summary: firstLineOf(err) });
  }

  try {
    const s = await synthesizeFn(db, {}, { now, env });
    steps.push({
      name: 'synthesize', ok: true,
      summary: s.fired
        ? `Digest: ${s.itemCount} items, ${s.annotated} annotated.`
        : `Digest: not fired (${s.reason}).`,
    });
  } catch (err) {
    steps.push({ name: 'synthesize', ok: false, summary: firstLineOf(err) });
  }

  try {
    const outDir = resolve(env.BELLWETHER_EXPORT_DIR ?? './web/public/data');
    const s = exportFn(db, outDir, { now });
    steps.push({
      name: 'export', ok: true,
      summary: `Wrote ${s.files.join(', ')} to ${outDir} — ` +
        `${s.competitors} competitors, ${s.healthySources}/${s.totalSources} sources healthy.`,
    });
  } catch (err) {
    steps.push({ name: 'export', ok: false, summary: firstLineOf(err) });
  }

  if (deps.heartbeat) {
    try {
      await deps.heartbeat(db);
      steps.push({ name: 'heartbeat', ok: true, summary: 'sent' });
    } catch (err) {
      steps.push({ name: 'heartbeat', ok: false, summary: firstLineOf(err) });
    }
  }

  return { steps };
}
