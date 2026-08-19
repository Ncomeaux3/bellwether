import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { runDoctor } from '../src/ops/doctor.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-doctor-'));
  db = openDb(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function baseDeps() {
  return {
    db,
    env: { BELLWETHER_DB: './data/bellwether.db', BELLWETHER_EXPORT_DIR: './web/public/data' },
    fetcher: async () => ({ ok: true, httpStatus: 200, body: '<h2>Enterprise</h2> $20', error: null }),
    gitPush: async () => ({ ok: true, detail: 'deploy key can push' }),
  };
}

function find(results: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const r = results.find(x => x.name === name);
  if (!r) throw new Error(`no check named ${name}`);
  return r;
}

describe('runDoctor', () => {
  it('fails the environment check when a required variable is missing', async () => {
    const results = await runDoctor({ ...baseDeps(), env: {} });
    const check = find(results, 'environment');
    expect(check.status).toBe('fail');
    expect(check.fix).toMatch(/\.env\.example/);
  });

  it('fails the environment check when a required variable is set but empty', async () => {
    const results = await runDoctor({
      ...baseDeps(),
      env: { BELLWETHER_DB: '', BELLWETHER_EXPORT_DIR: './web/public/data' },
    });
    expect(find(results, 'environment').status).toBe('fail');
  });

  it('fails the schema check when migrations have not been applied', async () => {
    const results = await runDoctor(baseDeps());
    const check = find(results, 'schema');
    expect(check.status).toBe('fail');
    expect(check.fix).toMatch(/bellwether migrate/);
  });

  it('skips source checks entirely when the schema check fails', async () => {
    const results = await runDoctor(baseDeps());
    expect(find(results, 'schema').status).toBe('fail');
    expect(results.some(r => r.name.startsWith('source:'))).toBe(false);
  });

  it('passes the schema check once migrations are applied', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor(baseDeps());
    expect(find(results, 'schema').status).toBe('ok');
  });

  it('reports a source whose canary is missing', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    seedCompetitors(db, CONFIG);

    const results = await runDoctor({
      ...baseDeps(),
      fetcher: async () => ({ ok: true, httpStatus: 200, body: '<html>redesigned</html>', error: null }),
    });

    const check = find(results, 'source: acme/pricing');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/canary/i);
  });

  it('passes every source check when pages are healthy', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    seedCompetitors(db, CONFIG);

    const results = await runDoctor(baseDeps());
    expect(find(results, 'source: acme/pricing').status).toBe('ok');
  });

  it('marks the not-yet-built anthropic key check as pending, never as a failure', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor(baseDeps());
    const check = find(results, 'anthropic key');
    expect(check.status).toBe('pending');
    expect(check.detail).toMatch(/M2/);
  });

  describe('telegram alerts check', () => {
    it('is pending when neither TELEGRAM_BOT_TOKEN nor TELEGRAM_CHAT_ID is set', async () => {
      migrate(db, join(process.cwd(), 'migrations'));
      const results = await runDoctor(baseDeps());
      expect(find(results, 'telegram alerts').status).toBe('pending');
    });

    it('is ok when both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set', async () => {
      migrate(db, join(process.cwd(), 'migrations'));
      const results = await runDoctor({
        ...baseDeps(),
        env: { ...baseDeps().env, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123' },
      });
      expect(find(results, 'telegram alerts').status).toBe('ok');
    });

    it('fails when only one of TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is set', async () => {
      migrate(db, join(process.cwd(), 'migrations'));
      const results = await runDoctor({
        ...baseDeps(),
        env: { ...baseDeps().env, TELEGRAM_BOT_TOKEN: 'tok' },
      });
      const check = find(results, 'telegram alerts');
      expect(check.status).toBe('fail');
      expect(check.fix).toBeTruthy();
    });
  });

  describe('backup target check', () => {
    it('is pending when RESTIC_REPOSITORY is unset', async () => {
      migrate(db, join(process.cwd(), 'migrations'));
      const results = await runDoctor(baseDeps());
      expect(find(results, 'backup target').status).toBe('pending');
    });

    it('is ok when RESTIC_REPOSITORY and RESTIC_PASSWORD are both set', async () => {
      migrate(db, join(process.cwd(), 'migrations'));
      const results = await runDoctor({
        ...baseDeps(),
        env: { ...baseDeps().env, RESTIC_REPOSITORY: 'b2:bucket:bw', RESTIC_PASSWORD: 'secret' },
      });
      expect(find(results, 'backup target').status).toBe('ok');
    });

    it('fails when RESTIC_REPOSITORY is set but RESTIC_PASSWORD is not', async () => {
      migrate(db, join(process.cwd(), 'migrations'));
      const results = await runDoctor({
        ...baseDeps(),
        env: { ...baseDeps().env, RESTIC_REPOSITORY: 'b2:bucket:bw' },
      });
      const check = find(results, 'backup target');
      expect(check.status).toBe('fail');
      expect(check.fix).toBeTruthy();
    });
  });

  it('reports git push as not-applicable when there is no repository', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      gitPush: async () => ({ ok: true, skipped: true, detail: 'not a git repository — publishing runs on the host, not in the container' }),
    });

    const check = find(results, 'git push');
    // Inside the container there is no .git and no deploy key, so a failure here
    // would be a permanent red the operator could never clear.
    expect(check.status).toBe('pending');
    expect(check.detail).toMatch(/not a git repository/i);
  });

  it('reports git push failure with the command to diagnose it', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      gitPush: async () => ({ ok: false, detail: 'permission denied' }),
    });

    const check = find(results, 'git push');
    expect(check.status).toBe('fail');
    expect(check.fix).toBeTruthy();
  });

  it('omits the publish script check entirely when no publishScript dep is injected', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor(baseDeps());
    expect(results.some(r => r.name === 'publish script')).toBe(false);
  });

  it('passes the publish script check when ops/publish.sh exists and is executable', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      publishScript: async () => ({ ok: true, detail: 'ops/publish.sh is executable' }),
    });

    const check = find(results, 'publish script');
    expect(check.status).toBe('ok');
  });

  it('reports the publish script as not-applicable inside the container, where ops/ is never copied in', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      publishScript: async () => ({
        ok: true, skipped: true,
        detail: 'ops/publish.sh not present — publishing runs on the host, not in the container',
      }),
    });

    const check = find(results, 'publish script');
    // Same reasoning as git push: the container never has ops/, so failing
    // here would be a permanent red the operator could never clear.
    expect(check.status).toBe('pending');
    expect(check.detail).toMatch(/publishing runs on the host/i);
  });

  it('fails the publish script check when the file exists but is not executable', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      publishScript: async () => ({ ok: false, detail: 'ops/publish.sh exists but is not executable' }),
    });

    const check = find(results, 'publish script');
    expect(check.status).toBe('fail');
    expect(check.fix).toMatch(/chmod \+x/);
  });

  it('reports site export dir as not-applicable when BELLWETHER_EXPORT_DIR is unset', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({ ...baseDeps(), env: {} });

    const check = find(results, 'site export dir');
    expect(check.status).toBe('pending');
  });

  it('does not fail site export dir on the Mac shape: a relative export dir, no site var set', async () => {
    // This is exactly .env.example's and the real Mac .env's shape
    // (BELLWETHER_EXPORT_DIR=./web/public/data) — a SET export dir that is
    // not a container path must never read as proof of container mode.
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      env: { BELLWETHER_DB: './data/bellwether.db', BELLWETHER_EXPORT_DIR: './web/public/data' },
    });

    const check = find(results, 'site export dir');
    expect(check.status).not.toBe('fail');
    expect(check.status).toBe('pending');
  });

  it('passes site export dir when BELLWETHER_SITE_EXPORT_DIR matches BELLWETHER_EXPORT_DIR', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      env: { BELLWETHER_DB: './data/bellwether.db', BELLWETHER_EXPORT_DIR: '/data/export', BELLWETHER_SITE_EXPORT_DIR: '/data/export' },
    });

    const check = find(results, 'site export dir');
    expect(check.status).toBe('ok');
  });

  it('fails site export dir when BELLWETHER_SITE_EXPORT_DIR is unset or mismatched while BELLWETHER_EXPORT_DIR is set', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor({
      ...baseDeps(),
      env: { BELLWETHER_DB: './data/bellwether.db', BELLWETHER_EXPORT_DIR: '/data/export' },
    });

    const check = find(results, 'site export dir');
    expect(check.status).toBe('fail');
    expect(check.fix).toMatch(/docker-compose\.yml/);
  });
});
