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

  it('marks not-yet-built checks as pending, never as failures', async () => {
    migrate(db, join(process.cwd(), 'migrations'));
    const results = await runDoctor(baseDeps());

    for (const name of ['anthropic key', 'telegram alerts', 'backup target']) {
      const check = find(results, name);
      expect(check.status).toBe('pending');
      expect(check.detail).toMatch(/M[25]/);
    }
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
});
