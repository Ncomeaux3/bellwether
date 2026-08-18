# Bellwether M1 — Skeleton That Ships — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the collection half of Bellwether end to end — schema, polite fetcher, hash-gated collection, guarded export — and publish a live public board at `bellwether.cmxlogic.com` showing six competitors' source health.

**Architecture:** A TypeScript CLI on the homelab writes to SQLite (WAL). Every pipeline step is independently invocable and idempotent, querying the DB for outstanding work rather than holding state. `export` renders derived JSON into `web/public/data/`, commits, and pushes; Vercel rebuilds a static Next.js site from it. No extraction, no LLM calls, no charts in M1 — those are M2 and M3.

**Tech Stack:** Node 24 LTS, TypeScript (ESM, strict), pnpm, `better-sqlite3`, `commander`, Zod, Vitest, Next.js App Router (static export) with Tailwind v4, Docker Compose, GitHub Actions, Vercel.

**Spec:** `docs/superpowers/specs/2026-08-18-bellwether-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **The LLM never decides control flow. It only fills in a schema.** (spec 5.1) No LLM calls at all in M1.
- **A failed fetch writes `ok=0` with no `raw_content` and never overwrites the last good snapshot.** (spec 11)
- **`raw_content` is written only when `raw_hash` is new for that source.** When the hash repeats, the snapshot row is still written but `raw_content` is left NULL. (spec 7.2)
- **`snapshots.observed_at` is the capture time, not the fetch time.** (spec 12.1) In M1 all provenance is `live`, so they coincide — but the column semantics are already correct and must not be conflated.
- **Export refuses to publish an empty or collapsed dataset.** Before committing, assert the generated JSON parses, `board.json` contains at least as many competitors as the previous published version, and no file shrank by more than 50%. (spec 15.7)
- **Single-writer lock.** A step refuses to start if a `runs` row of the same kind is `running` and started under 6 hours ago; older ones are marked crashed and cleared. (spec 15.5)
- **Degraded is a state with a defined exit.** Canary failure sets `degraded_reason`; the next successful fetch whose canary passes clears it automatically. (spec 15.6)
- **Politeness, non-negotiable** (spec 11): identifying User-Agent with a contact URL; `robots.txt` fetched, cached 24h, honored; minimum 10s between requests to the same host with jitter; 3 retries with exponential backoff; redirect cap 5; body cap 5 MB; public pages only.
- **SQLite in WAL mode**, `foreign_keys = ON`, `busy_timeout = 5000`. (spec 6)
- **Timezone `America/Chicago`** for scheduling; **all stored timestamps are ISO 8601 UTC strings** (`new Date().toISOString()`).
- **Migrations are immutable.** A changed checksum on an applied migration is a hard error; add a new file instead. (spec 7)
- **Copy rules** (spec 14.3): active voice, sentence case, named from the reader's side. Empty and failure states state what happened and what to do — never "No data", never "Error".
- **Quality floor** (spec 14.3): responsive to mobile, visible keyboard focus, `prefers-reduced-motion` respected, semantic `<table>` for tabular data, readable at 200% zoom.
- **No network access in tests.** Every HTTP test runs against a local `node:http` server on an ephemeral port.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Toolchain |
| `.env.example` | Every variable documented with where to get it |
| `.github/workflows/ci.yml` | Typecheck + tests on PR, `LLM_ENABLED=false` |
| `migrations/001_init.sql` | Full schema from spec 7 |
| `src/ops/db.ts` | Open a connection with the required pragmas |
| `src/ops/migrate.ts` | Apply migrations, enforce checksum immutability |
| `src/ops/runs.ts` | Single-writer lock; `runs` row lifecycle |
| `src/config/types.ts` | `CompetitorConfig`, `SourceConfig` |
| `src/config/competitors.public.ts` | The six verified sources |
| `src/config/seed.ts` | Idempotent config → DB |
| `src/tools/hash.ts` | `sha256` |
| `src/tools/robots.ts` | Minimal robots.txt parser + allow check |
| `src/tools/ratelimit.ts` | Per-host spacing with jitter |
| `src/tools/fetch.ts` | The polite fetcher |
| `src/workflow/collect.ts` | Cadence, fetch, hash gate, dedup, canary, degraded state |
| `src/workflow/export.ts` | Derived JSON + publish guards |
| `src/ops/doctor.ts` | Preflight checks |
| `src/cli.ts` | Command wiring |
| `web/` | Next.js static site: layout, board, tokens |
| `Dockerfile`, `docker-compose.yml` | Runtime + healthcheck on `runs` freshness |

---

## Task 1: Project scaffold and CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.github/workflows/ci.yml`
- Create: `src/version.ts`
- Test: `tests/version.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `USER_AGENT: string` — the identifying UA every outbound request must send.

- [ ] **Step 1: Initialize the package**

```bash
cd "/Users/ncomeaux/VsCode/Competitor Watcher"
pnpm init
pnpm add better-sqlite3 commander zod
pnpm add -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 2: Replace `package.json` with this**

Keep whatever version numbers `pnpm add` resolved in `dependencies` and `devDependencies`; replace only the surrounding fields.

```json
{
  "name": "bellwether",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "bw": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["web"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
```

- [ ] **Step 5: Write the failing test**

`tests/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { USER_AGENT } from '../src/version.js';

describe('USER_AGENT', () => {
  it('identifies the project and carries a contact URL', () => {
    expect(USER_AGENT).toContain('Bellwether');
    expect(USER_AGENT).toContain('https://bellwether.cmxlogic.com/about');
  });

  it('is a single line', () => {
    expect(USER_AGENT).not.toContain('\n');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../src/version.js`.

- [ ] **Step 7: Write minimal implementation**

`src/version.ts`:

```ts
export const VERSION = '0.1.0';

/**
 * Identifying User-Agent. Spec 11 requires a contact URL so any site operator
 * who notices the traffic can reach a human instead of blocking a mystery bot.
 */
export const USER_AGENT =
  `Bellwether/${VERSION} (+https://bellwether.cmxlogic.com/about; open pricing archive; nicholas@cmxlogic.com)`;
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS, 2 tests.

- [ ] **Step 9: Write `.env.example`**

```bash
# --- Database -------------------------------------------------------------
# Path to the SQLite archive. Docker mounts ./data; locally ./data works too.
BELLWETHER_DB=./data/bellwether.db

# --- LLM (M2+; unused in M1) ---------------------------------------------
# console.anthropic.com -> API keys
ANTHROPIC_API_KEY=
# Set false to run the whole pipeline with zero LLM spend. CI uses false.
LLM_ENABLED=false
# Hard ceiling on recurring monthly spend, US dollars (spec 15.2).
BELLWETHER_MONTHLY_BUDGET_USD=5.00

# --- Publishing -----------------------------------------------------------
# Directory the static site reads at build time.
BELLWETHER_EXPORT_DIR=./web/public/data

# --- Alerts (M5; unused in M1) -------------------------------------------
# Create a bot with @BotFather, then message it and read the chat id.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# --- Backup (M5; unused in M1) -------------------------------------------
# backblaze.com -> Buckets, then Application Keys
B2_BUCKET=
B2_KEY_ID=
B2_APP_KEY=
RESTIC_PASSWORD=
```

- [ ] **Step 10: Write `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      LLM_ENABLED: 'false'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .env.example \
        .github/workflows/ci.yml src/version.ts tests/version.test.ts
git commit -m "chore: scaffold TypeScript project, Vitest, and CI"
```

---

## Task 2: Database connection and migrations

**Files:**
- Create: `src/ops/db.ts`, `src/ops/migrate.ts`, `migrations/001_init.sql`, `src/cli.ts`
- Test: `tests/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `openDb(path: string): DB` — opens with WAL, foreign keys, busy timeout.
  - `type DB = Database.Database`
  - `migrate(db: DB, dir: string): string[]` — returns the versions applied this call; throws on a changed checksum.

- [ ] **Step 1: Write the failing test**

`tests/migrate.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-mig-'));
  db = openDb(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeMigration(name: string, sql: string): string {
  const migDir = join(dir, 'migrations');
  writeFileSync(join(migDir, name), sql);
  return migDir;
}

describe('openDb', () => {
  it('enables WAL and foreign keys', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('migrate', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'migrations'), { recursive: true });
  });

  it('applies pending migrations in filename order', () => {
    const migDir = writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeMigration('002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');

    const applied = migrate(db, migDir);

    expect(applied).toEqual(['001_a.sql', '002_b.sql']);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('a');
    expect(tables.map(t => t.name)).toContain('b');
  });

  it('is idempotent — a second run applies nothing', () => {
    const migDir = writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, migDir);
    expect(migrate(db, migDir)).toEqual([]);
  });

  it('throws when an already-applied migration changes', () => {
    const migDir = writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, migDir);
    writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);');

    expect(() => migrate(db, migDir)).toThrow(/immutable/i);
  });

  it('rolls back a failing migration entirely', () => {
    const migDir = writeMigration(
      '001_bad.sql',
      'CREATE TABLE good (id INTEGER PRIMARY KEY); THIS IS NOT SQL;'
    );

    expect(() => migrate(db, migDir)).toThrow();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[];
    expect(tables.map(t => t.name)).not.toContain('good');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/migrate.test.ts`
Expected: FAIL — cannot resolve `../src/ops/db.js`.

- [ ] **Step 3: Write `src/ops/db.ts`**

```ts
import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Spec 6: WAL so readers never block the single writer — `export` can read
 * while `collect` writes. busy_timeout covers the brief lock during commit.
 */
export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
```

- [ ] **Step 4: Write `src/ops/migrate.ts`**

```ts
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';

interface AppliedRow { version: string; checksum: string }

/**
 * Applies pending .sql files in filename order, inside a transaction each.
 * Spec 7: migrations are immutable — editing an applied file is a hard error,
 * because the DB it produced no longer matches the file that claims to describe it.
 */
export function migrate(db: DB, dir: string): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  const prior = new Map(
    (db.prepare('SELECT version, checksum FROM schema_migrations').all() as AppliedRow[])
      .map(r => [r.version, r.checksum] as const)
  );

  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const seen = prior.get(file);

    if (seen === checksum) continue;
    if (seen !== undefined) {
      throw new Error(
        `Migration ${file} changed after it was applied. Migrations are immutable — ` +
        `add a new migration file instead of editing this one.`
      );
    }

    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)'
      ).run(file, new Date().toISOString(), checksum);
    })();

    applied.push(file);
  }

  return applied;
}
```

- [ ] **Step 5: Write `migrations/001_init.sql`**

This is the complete schema from spec 7. M1 writes to `competitors`, `sources`, `snapshots`, and `runs`; the rest are created now so no later milestone needs a migration to catch up.

```sql
CREATE TABLE competitors (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  homepage TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  canary_string TEXT NOT NULL,
  cadence_hours INTEGER NOT NULL DEFAULT 24,
  active INTEGER NOT NULL DEFAULT 1,
  degraded_reason TEXT,
  UNIQUE (competitor_id, kind, url)
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  observed_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  raw_content TEXT,
  raw_hash TEXT,
  normalized_hash TEXT,
  provenance TEXT NOT NULL
);
CREATE INDEX idx_snap_source_time ON snapshots(source_id, observed_at);
CREATE INDEX idx_snap_raw_hash ON snapshots(source_id, raw_hash);

CREATE TABLE extractions (
  id INTEGER PRIMARY KEY,
  normalized_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  extraction_confidence TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  grounded INTEGER NOT NULL DEFAULT 1,
  is_backfill INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_micros INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (normalized_hash, prompt_version)
);

CREATE TABLE changes (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  from_snapshot_id INTEGER NOT NULL,
  to_snapshot_id INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  json_path TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  materiality INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'candidate',
  observed_at TEXT NOT NULL,
  UNIQUE (source_id, from_snapshot_id, to_snapshot_id, json_path)
);

CREATE TABLE analyses (
  id INTEGER PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES changes(id),
  implication TEXT NOT NULL,
  so_what TEXT NOT NULL,
  confidence TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (change_id, prompt_version)
);

CREATE TABLE digests (
  id INTEGER PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  body_md TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  cost_micros INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (period_start, prompt_version)
);

CREATE TABLE backfill_queue (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  wayback_ts TEXT NOT NULL,
  target_url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, wayback_ts)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  ok INTEGER,
  stats_json TEXT,
  error TEXT
);
CREATE INDEX idx_runs_kind_state ON runs(kind, state, started_at);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/migrate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Write `src/cli.ts` with the first command**

```ts
#!/usr/bin/env tsx
import { Command } from 'commander';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { openDb } from './ops/db.js';
import { migrate } from './ops/migrate.js';
import { VERSION } from './version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function dbPath(): string {
  const p = process.env.BELLWETHER_DB ?? './data/bellwether.db';
  mkdirSync(dirname(resolve(p)), { recursive: true });
  return resolve(p);
}

const program = new Command();
program.name('bellwether').version(VERSION);

program
  .command('migrate')
  .description('apply pending database migrations')
  .action(() => {
    const db = openDb(dbPath());
    const applied = migrate(db, join(ROOT, 'migrations'));
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is current.');
    db.close();
  });

program.parseAsync(process.argv);
```

- [ ] **Step 8: Verify the command runs end to end**

Run: `pnpm bw migrate && pnpm bw migrate`
Expected: first prints `Applied: 001_init.sql`, second prints `Schema is current.`

- [ ] **Step 9: Commit**

```bash
git add src/ops/db.ts src/ops/migrate.ts src/cli.ts migrations/001_init.sql tests/migrate.test.ts
git commit -m "feat: SQLite connection, immutable migrations, and initial schema"
```

---

## Task 3: Competitor configuration and seeding

**Files:**
- Create: `src/config/types.ts`, `src/config/competitors.public.ts`, `src/config/seed.ts`
- Modify: `src/cli.ts` — add the `seed` command
- Test: `tests/seed.test.ts`

**Interfaces:**
- Consumes: `openDb`, `migrate` (Task 2).
- Produces:
  - `interface SourceConfig { kind: 'pricing'; url: string; canaryString: string; cadenceHours: number }`
  - `interface CompetitorConfig { slug: string; name: string; homepage: string; sources: SourceConfig[] }`
  - `COMPETITORS: CompetitorConfig[]`
  - `seedCompetitors(db: DB, competitors: CompetitorConfig[]): { competitors: number; sources: number }`

- [ ] **Step 1: Write the failing test**

`tests/seed.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { COMPETITORS } from '../src/config/competitors.public.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-seed-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sample: CompetitorConfig[] = [
  {
    slug: 'acme',
    name: 'Acme',
    homepage: 'https://acme.test',
    sources: [
      { kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 },
    ],
  },
];

describe('seedCompetitors', () => {
  it('inserts competitors and their sources', () => {
    const stats = seedCompetitors(db, sample);
    expect(stats).toEqual({ competitors: 1, sources: 1 });

    const row = db.prepare('SELECT slug, name FROM competitors').get() as { slug: string; name: string };
    expect(row.slug).toBe('acme');
  });

  it('is idempotent — running twice does not duplicate rows', () => {
    seedCompetitors(db, sample);
    seedCompetitors(db, sample);

    const c = db.prepare('SELECT COUNT(*) AS n FROM competitors').get() as { n: number };
    const s = db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
    expect(c.n).toBe(1);
    expect(s.n).toBe(1);
  });

  it('updates a changed canary string in place', () => {
    seedCompetitors(db, sample);
    const changed: CompetitorConfig[] = [{
      ...sample[0]!,
      sources: [{ ...sample[0]!.sources[0]!, canaryString: 'Business' }],
    }];
    seedCompetitors(db, changed);

    const row = db.prepare('SELECT canary_string FROM sources').get() as { canary_string: string };
    expect(row.canary_string).toBe('Business');
  });

  it('never clears degraded_reason as a side effect of reseeding', () => {
    seedCompetitors(db, sample);
    db.prepare("UPDATE sources SET degraded_reason = 'canary missing'").run();
    seedCompetitors(db, sample);

    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toBe('canary missing');
  });
});

describe('COMPETITORS', () => {
  it('contains the six sources verified server-rendered in spec 11.1', () => {
    expect(COMPETITORS).toHaveLength(6);
    expect(COMPETITORS.map(c => c.slug).sort()).toEqual(
      ['figma', 'linear', 'notion', 'postman', 'sentry', 'supabase']
    );
  });

  it('gives every source an https url and a non-empty canary', () => {
    for (const c of COMPETITORS) {
      for (const s of c.sources) {
        expect(s.url.startsWith('https://')).toBe(true);
        expect(s.canaryString.length).toBeGreaterThan(0);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/seed.test.ts`
Expected: FAIL — cannot resolve `../src/config/seed.js`.

- [ ] **Step 3: Write `src/config/types.ts`**

```ts
export type SourceKind = 'pricing';

export interface SourceConfig {
  kind: SourceKind;
  url: string;
  /**
   * A string that must appear in the raw HTML for the page to be considered
   * intact. Spec 15.6: its absence marks the source degraded rather than
   * feeding a redesigned page downstream as if nothing happened.
   */
  canaryString: string;
  cadenceHours: number;
}

export interface CompetitorConfig {
  slug: string;
  name: string;
  homepage: string;
  sources: SourceConfig[];
}
```

- [ ] **Step 4: Write `src/config/competitors.public.ts`**

```ts
import type { CompetitorConfig } from './types.js';

/**
 * The six sources verified 2026-08-18 as server-rendered with prices and tier
 * names present in raw HTML (spec 11.1). Vercel and Jira were screened out —
 * both hydrate pricing client-side.
 *
 * Canary strings are deliberately conservative for M1. `bellwether qualify`
 * (M3.5) proposes stronger per-site canaries once it exists.
 */
export const COMPETITORS: CompetitorConfig[] = [
  {
    slug: 'linear',
    name: 'Linear',
    homepage: 'https://linear.app',
    sources: [{ kind: 'pricing', url: 'https://linear.app/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'notion',
    name: 'Notion',
    homepage: 'https://www.notion.com',
    sources: [{ kind: 'pricing', url: 'https://www.notion.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'figma',
    name: 'Figma',
    homepage: 'https://www.figma.com',
    sources: [{ kind: 'pricing', url: 'https://www.figma.com/pricing/', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'supabase',
    name: 'Supabase',
    homepage: 'https://supabase.com',
    sources: [{ kind: 'pricing', url: 'https://supabase.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    homepage: 'https://sentry.io',
    sources: [{ kind: 'pricing', url: 'https://sentry.io/pricing/', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'postman',
    name: 'Postman',
    homepage: 'https://www.postman.com',
    sources: [{ kind: 'pricing', url: 'https://www.postman.com/pricing/', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
];
```

- [ ] **Step 5: Write `src/config/seed.ts`**

```ts
import type { DB } from '../ops/db.js';
import type { CompetitorConfig } from './types.js';

export interface SeedStats { competitors: number; sources: number }

/**
 * Config is the source of truth for identity and cadence; the database is the
 * source of truth for observed state. Reseeding therefore updates name, url,
 * canary, and cadence — and deliberately never touches `degraded_reason`,
 * which is runtime state that only a successful fetch may clear (spec 15.6).
 */
export function seedCompetitors(db: DB, competitors: CompetitorConfig[]): SeedStats {
  const upsertCompetitor = db.prepare(`
    INSERT INTO competitors (slug, name, homepage, active)
    VALUES (@slug, @name, @homepage, 1)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      homepage = excluded.homepage,
      active = 1
  `);

  const selectCompetitorId = db.prepare('SELECT id FROM competitors WHERE slug = ?');

  const upsertSource = db.prepare(`
    INSERT INTO sources (competitor_id, kind, url, canary_string, cadence_hours, active)
    VALUES (@competitorId, @kind, @url, @canaryString, @cadenceHours, 1)
    ON CONFLICT(competitor_id, kind, url) DO UPDATE SET
      canary_string = excluded.canary_string,
      cadence_hours = excluded.cadence_hours,
      active = 1
  `);

  let sources = 0;

  db.transaction(() => {
    for (const c of competitors) {
      upsertCompetitor.run(c);
      const { id } = selectCompetitorId.get(c.slug) as { id: number };
      for (const s of c.sources) {
        upsertSource.run({ competitorId: id, ...s });
        sources += 1;
      }
    }
  })();

  return { competitors: competitors.length, sources };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/seed.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Add the `seed` command to `src/cli.ts`**

Insert immediately after the `migrate` command block:

```ts
program
  .command('seed')
  .description('load the public competitor config into the database')
  .action(async () => {
    const { seedCompetitors } = await import('./config/seed.js');
    const { COMPETITORS } = await import('./config/competitors.public.js');
    const db = openDb(dbPath());
    const stats = seedCompetitors(db, COMPETITORS);
    console.log(`Seeded ${stats.competitors} competitors and ${stats.sources} sources.`);
    db.close();
  });
```

- [ ] **Step 8: Verify the command runs end to end**

Run: `pnpm bw migrate && pnpm bw seed && pnpm bw seed`
Expected: both seeds print `Seeded 6 competitors and 6 sources.` with no duplicate-row errors.

- [ ] **Step 9: Commit**

```bash
git add src/config tests/seed.test.ts src/cli.ts
git commit -m "feat: competitor config and idempotent seeding"
```

---

## Task 4: The polite fetcher

**Files:**
- Create: `src/tools/hash.ts`, `src/tools/robots.ts`, `src/tools/ratelimit.ts`, `src/tools/fetch.ts`
- Test: `tests/robots.test.ts`, `tests/fetch.test.ts`

**Interfaces:**
- Consumes: `USER_AGENT` (Task 1).
- Produces:
  - `sha256(input: string): string`
  - `parseRobots(text: string, agentToken: string): RobotsRules`
  - `isPathAllowed(rules: RobotsRules, path: string): boolean`
  - `class HostRateLimiter { constructor(minIntervalMs: number, jitterMs: number, deps?: RateLimiterDeps); wait(host: string): Promise<void> }`
  - `class RobotsCache { constructor(deps?: RobotsCacheDeps); allowed(url: string): Promise<boolean> }`
  - `politeFetch(url: string, deps?: FetchDeps): Promise<FetchResult>`
  - `interface FetchResult { ok: boolean; httpStatus: number | null; body: string | null; error: string | null }`

- [ ] **Step 1: Write the failing robots test**

`tests/robots.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots } from '../src/tools/robots.js';

const SAMPLE = `
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /admin
Disallow: /internal/
Allow: /internal/public

Sitemap: https://example.test/sitemap.xml
`;

describe('parseRobots', () => {
  it('uses the wildcard group when our token has no group', () => {
    const rules = parseRobots(SAMPLE, 'Bellwether');
    expect(rules.disallow).toContain('/admin');
    expect(rules.allow).toContain('/internal/public');
  });

  it('prefers a group naming our token over the wildcard', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: Bellwether\nDisallow: /nope\n',
      'Bellwether'
    );
    expect(rules.disallow).toEqual(['/nope']);
  });

  it('treats an empty file as fully permissive', () => {
    const rules = parseRobots('', 'Bellwether');
    expect(rules.disallow).toEqual([]);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# comment\nUser-agent: *\n\n  Disallow: /x  \n', 'Bellwether');
    expect(rules.disallow).toEqual(['/x']);
  });
});

describe('isPathAllowed', () => {
  const rules = parseRobots(SAMPLE, 'Bellwether');

  it('allows a path no rule matches', () => {
    expect(isPathAllowed(rules, '/pricing')).toBe(true);
  });

  it('blocks a disallowed prefix', () => {
    expect(isPathAllowed(rules, '/admin/users')).toBe(false);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    expect(isPathAllowed(rules, '/internal/public/doc')).toBe(true);
    expect(isPathAllowed(rules, '/internal/secret')).toBe(false);
  });

  it('blocks everything under a bare Disallow: /', () => {
    const all = parseRobots('User-agent: *\nDisallow: /\n', 'Bellwether');
    expect(isPathAllowed(all, '/pricing')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/robots.test.ts`
Expected: FAIL — cannot resolve `../src/tools/robots.js`.

- [ ] **Step 3: Write `src/tools/hash.ts`**

```ts
import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Write `src/tools/robots.ts`**

```ts
export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

/**
 * Minimal robots.txt parser — deliberately dependency-free.
 * Picks the group naming our token if present, otherwise the wildcard group.
 */
export function parseRobots(text: string, agentToken: string): RobotsRules {
  const groups = new Map<string, RobotsRules>();
  let current: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [] });
      current = [agent];
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (value === '') continue;

    for (const agent of current) {
      const group = groups.get(agent);
      if (!group) continue;
      if (field === 'allow') group.allow.push(value);
      else group.disallow.push(value);
    }
  }

  return groups.get(agentToken.toLowerCase())
    ?? groups.get('*')
    ?? { allow: [], disallow: [] };
}

/** Longest matching rule wins; Allow beats Disallow at equal length. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const longest = (patterns: string[]): number => {
    let best = -1;
    for (const p of patterns) {
      if (path.startsWith(p) && p.length > best) best = p.length;
    }
    return best;
  };

  const allow = longest(rules.allow);
  const disallow = longest(rules.disallow);

  if (disallow === -1) return true;
  return allow >= disallow;
}
```

- [ ] **Step 5: Run robots test to verify it passes**

Run: `pnpm test tests/robots.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Write `src/tools/ratelimit.ts`**

```ts
export interface RateLimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Spec 11: minimum 10s between requests to the same host, jittered.
 * Per-host, so six competitors on six hosts never wait on each other.
 */
export class HostRateLimiter {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = 10_000,
    private readonly jitterMs = 3_000,
    private readonly deps: RateLimiterDeps = {}
  ) {}

  async wait(host: string): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? defaultSleep;
    const random = this.deps.random ?? Math.random;

    const previous = this.last.get(host);
    if (previous !== undefined) {
      const target = previous + this.minIntervalMs + random() * this.jitterMs;
      const delay = target - now();
      if (delay > 0) await sleep(delay);
    }
    this.last.set(host, now());
  }
}
```

- [ ] **Step 7: Write the failing fetch test**

`tests/fetch.test.ts`. Every case runs against a local `node:http` server — no network.

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HostRateLimiter } from '../src/tools/ratelimit.js';
import { RobotsCache, politeFetch } from '../src/tools/fetch.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  server = undefined;
});

interface Routes { [path: string]: (req: any, res: any) => void }

async function start(routes: Routes): Promise<string> {
  server = createServer((req, res) => {
    const handler = routes[req.url ?? '/'];
    if (!handler) { res.writeHead(404); res.end('not found'); return; }
    handler(req, res);
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

/** No real waiting in tests. */
function fastDeps() {
  return {
    limiter: new HostRateLimiter(0, 0, { sleep: async () => {} }),
    robots: new RobotsCache({ sleep: async () => {} }),
    sleep: async () => {},
  };
}

describe('politeFetch', () => {
  it('returns the body on 200 and sends the identifying User-Agent', async () => {
    let seenUA = '';
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/pricing': (req, res) => {
        seenUA = String(req.headers['user-agent'] ?? '');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>Pro $20</html>');
      },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.body).toContain('Pro $20');
    expect(seenUA).toContain('Bellwether');
  });

  it('refuses a path robots.txt disallows, without requesting it', async () => {
    let hits = 0;
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nDisallow: /pricing\n'); },
      '/pricing': (_q, res) => { hits += 1; res.writeHead(200); res.end('nope'); },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/robots/i);
    expect(hits).toBe(0);
  });

  it('treats a missing robots.txt as permissive', async () => {
    const base = await start({
      '/pricing': (_q, res) => { res.writeHead(200); res.end('ok'); },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());
    expect(result.ok).toBe(true);
  });

  it('retries a 500 and succeeds when the server recovers', async () => {
    let calls = 0;
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/pricing': (_q, res) => {
        calls += 1;
        if (calls < 3) { res.writeHead(500); res.end('boom'); return; }
        res.writeHead(200); res.end('recovered');
      },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());

    expect(result.ok).toBe(true);
    expect(result.body).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry a 404', async () => {
    let calls = 0;
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/gone': (_q, res) => { calls += 1; res.writeHead(404); res.end('missing'); },
    });

    const result = await politeFetch(`${base}/gone`, fastDeps());

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(404);
    expect(calls).toBe(1);
  });

  it('rejects a body larger than the cap instead of buffering it', async () => {
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/huge': (_q, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        for (let i = 0; i < 40; i += 1) res.write('x'.repeat(200_000));
        res.end();
      },
    });

    const result = await politeFetch(`${base}/huge`, { ...fastDeps(), maxBytes: 1_000_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cap/i);
  });

  it('reports a connection failure as an error rather than throwing', async () => {
    const result = await politeFetch('http://127.0.0.1:1/pricing', fastDeps());
    expect(result.ok).toBe(false);
    expect(result.body).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm test tests/fetch.test.ts`
Expected: FAIL — cannot resolve `../src/tools/fetch.js`.

- [ ] **Step 9: Write `src/tools/fetch.ts`**

```ts
import { USER_AGENT } from '../version.js';
import { HostRateLimiter } from './ratelimit.js';
import { isPathAllowed, parseRobots, type RobotsRules } from './robots.js';

export interface FetchResult {
  ok: boolean;
  httpStatus: number | null;
  body: string | null;
  error: string | null;
}

const AGENT_TOKEN = 'Bellwether';
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const MAX_REDIRECTS = 5;

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface RobotsCacheDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CacheEntry { rules: RobotsRules; fetchedAt: number }

/** Spec 11: robots.txt fetched, cached 24h, honored. */
export class RobotsCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: RobotsCacheDeps = {}) {}

  async allowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const now = (this.deps.now ?? Date.now)();
    const key = parsed.origin;

    let entry = this.cache.get(key);
    if (!entry || now - entry.fetchedAt > ROBOTS_TTL_MS) {
      entry = { rules: await this.load(parsed.origin), fetchedAt: now };
      this.cache.set(key, entry);
    }

    return isPathAllowed(entry.rules, parsed.pathname);
  }

  /** A robots.txt we cannot read is treated as permissive — the standard's default. */
  private async load(origin: string): Promise<RobotsRules> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return { allow: [], disallow: [] };
      return parseRobots(await res.text(), AGENT_TOKEN);
    } catch {
      return { allow: [], disallow: [] };
    }
  }
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  limiter?: HostRateLimiter;
  robots?: RobotsCache;
  sleep?: (ms: number) => Promise<void>;
  maxBytes?: number;
  retries?: number;
  timeoutMs?: number;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Spec 11. Never throws: a failure is a FetchResult with ok=false, because the
 * caller must record the attempt either way — silence would read as stability.
 */
export async function politeFetch(url: string, deps: FetchDeps = {}): Promise<FetchResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const limiter = deps.limiter ?? new HostRateLimiter();
  const robots = deps.robots ?? new RobotsCache();
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = deps.retries ?? DEFAULT_RETRIES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, httpStatus: null, body: null, error: `Malformed URL: ${url}` };
  }

  try {
    if (!(await robots.allowed(url))) {
      return { ok: false, httpStatus: null, body: null, error: `Blocked by robots.txt: ${url}` };
    }
  } catch (err) {
    return { ok: false, httpStatus: null, body: null, error: `robots.txt check failed: ${String(err)}` };
  }

  let lastError = 'unknown error';
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    await limiter.wait(host);

    try {
      const res = await doFetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = res.status;

      // 4xx other than 429 is a settled answer — retrying wastes their bandwidth.
      if (!res.ok && res.status !== 429 && res.status < 500) {
        return { ok: false, httpStatus: res.status, body: null, error: `HTTP ${res.status}` };
      }
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }

      const body = await readCapped(res, maxBytes);
      return { ok: true, httpStatus: res.status, body, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (/cap$/i.test(lastError) || /byte cap/i.test(lastError)) {
        return { ok: false, httpStatus: lastStatus, body: null, error: lastError };
      }
    }
  }

  return { ok: false, httpStatus: lastStatus, body: null, error: lastError };
}

export { MAX_REDIRECTS };
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm test tests/fetch.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 11: Run the whole suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, all tests.

- [ ] **Step 12: Commit**

```bash
git add src/tools tests/robots.test.ts tests/fetch.test.ts
git commit -m "feat: polite fetcher with robots, per-host rate limiting, retries, and a byte cap"
```

---

## Task 5: The collect workflow

**Files:**
- Create: `src/ops/runs.ts`, `src/workflow/collect.ts`
- Modify: `src/cli.ts` — add the `collect` command
- Test: `tests/runs.test.ts`, `tests/collect.test.ts`

**Interfaces:**
- Consumes: `openDb`, `migrate`, `seedCompetitors`, `sha256`, `politeFetch`, `FetchResult`.
- Produces:
  - `acquireRun(db: DB, kind: string, deps?: RunDeps): number` — throws `RunLockedError`.
  - `finishRun(db: DB, id: number, ok: boolean, stats: unknown, error?: string): void`
  - `class RunLockedError extends Error`
  - `collect(db: DB, opts: CollectOptions, deps?: CollectDeps): Promise<CollectStats>`
  - `interface CollectStats { attempted: number; stored: number; unchanged: number; failed: number; degraded: number; cleared: number }`

- [ ] **Step 1: Write the failing runs test**

`tests/runs.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { RunLockedError, acquireRun, finishRun } from '../src/ops/runs.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-runs-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireRun', () => {
  it('creates a running row', () => {
    const id = acquireRun(db, 'collect');
    const row = db.prepare('SELECT kind, state FROM runs WHERE id = ?').get(id) as
      { kind: string; state: string };
    expect(row).toEqual({ kind: 'collect', state: 'running' });
  });

  it('refuses a second run of the same kind while one is running', () => {
    acquireRun(db, 'collect');
    expect(() => acquireRun(db, 'collect')).toThrow(RunLockedError);
  });

  it('allows a different kind to run concurrently', () => {
    acquireRun(db, 'collect');
    expect(() => acquireRun(db, 'export')).not.toThrow();
  });

  it('marks a run older than 6 hours as crashed and proceeds', () => {
    const stale = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    db.prepare("INSERT INTO runs (kind, started_at, state) VALUES ('collect', ?, 'running')").run(stale);

    const id = acquireRun(db, 'collect');

    const crashed = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state = 'crashed'").get() as { n: number };
    expect(crashed.n).toBe(1);
    expect(id).toBeGreaterThan(0);
  });

  it('allows a new run after the previous one finished', () => {
    finishRun(db, acquireRun(db, 'collect'), true, { stored: 1 });
    expect(() => acquireRun(db, 'collect')).not.toThrow();
  });
});

describe('finishRun', () => {
  it('records success with stats', () => {
    const id = acquireRun(db, 'collect');
    finishRun(db, id, true, { stored: 3 });

    const row = db.prepare('SELECT state, ok, stats_json, ended_at FROM runs WHERE id = ?').get(id) as
      { state: string; ok: number; stats_json: string; ended_at: string };
    expect(row.state).toBe('ok');
    expect(row.ok).toBe(1);
    expect(JSON.parse(row.stats_json)).toEqual({ stored: 3 });
    expect(row.ended_at).toBeTruthy();
  });

  it('records failure with the error text', () => {
    const id = acquireRun(db, 'collect');
    finishRun(db, id, false, {}, 'network down');

    const row = db.prepare('SELECT state, ok, error FROM runs WHERE id = ?').get(id) as
      { state: string; ok: number; error: string };
    expect(row.state).toBe('failed');
    expect(row.ok).toBe(0);
    expect(row.error).toBe('network down');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/runs.test.ts`
Expected: FAIL — cannot resolve `../src/ops/runs.js`.

- [ ] **Step 3: Write `src/ops/runs.ts`**

```ts
import type { DB } from './db.js';

export class RunLockedError extends Error {
  constructor(kind: string, startedAt: string) {
    super(
      `A ${kind} run started at ${startedAt} is still running. ` +
      `Wait for it to finish, or clear it if the process died: ` +
      `UPDATE runs SET state='crashed' WHERE kind='${kind}' AND state='running';`
    );
    this.name = 'RunLockedError';
  }
}

export interface RunDeps { now?: () => Date; staleHours?: number }

/**
 * Spec 15.5: single-writer lock. Cron overlap on a slow step would otherwise
 * put two writers on one SQLite file. Runs older than the stale window are
 * assumed dead — a crashed process never gets to mark itself failed.
 */
export function acquireRun(db: DB, kind: string, deps: RunDeps = {}): number {
  const now = (deps.now ?? (() => new Date()))();
  const staleHours = deps.staleHours ?? 6;
  const cutoff = new Date(now.getTime() - staleHours * 3600 * 1000).toISOString();

  return db.transaction(() => {
    db.prepare(
      "UPDATE runs SET state = 'crashed', ended_at = ?, error = 'exceeded stale window' " +
      "WHERE kind = ? AND state = 'running' AND started_at < ?"
    ).run(now.toISOString(), kind, cutoff);

    const held = db.prepare(
      "SELECT started_at FROM runs WHERE kind = ? AND state = 'running' ORDER BY started_at LIMIT 1"
    ).get(kind) as { started_at: string } | undefined;

    if (held) throw new RunLockedError(kind, held.started_at);

    const info = db.prepare(
      "INSERT INTO runs (kind, started_at, state) VALUES (?, ?, 'running')"
    ).run(kind, now.toISOString());

    return Number(info.lastInsertRowid);
  })();
}

export function finishRun(db: DB, id: number, ok: boolean, stats: unknown, error?: string): void {
  db.prepare(
    'UPDATE runs SET ended_at = ?, state = ?, ok = ?, stats_json = ?, error = ? WHERE id = ?'
  ).run(
    new Date().toISOString(),
    ok ? 'ok' : 'failed',
    ok ? 1 : 0,
    JSON.stringify(stats),
    error ?? null,
    id
  );
}
```

- [ ] **Step 4: Run runs test to verify it passes**

Run: `pnpm test tests/runs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing collect test**

`tests/collect.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { collect } from '../src/workflow/collect.js';
import type { FetchResult } from '../src/tools/fetch.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme',
  name: 'Acme',
  homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const GOOD_PAGE = '<html><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></html>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-collect-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function ok(body: string): FetchResult {
  return { ok: true, httpStatus: 200, body, error: null };
}
function fail(status: number | null, error: string): FetchResult {
  return { ok: false, httpStatus: status, body: null, error };
}
function at(iso: string) { return () => new Date(iso); }

describe('collect', () => {
  it('stores a snapshot with raw content on first sight', async () => {
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });

    expect(stats.attempted).toBe(1);
    expect(stats.stored).toBe(1);

    const row = db.prepare('SELECT ok, raw_content, raw_hash, provenance, observed_at FROM snapshots').get() as
      { ok: number; raw_content: string | null; raw_hash: string; provenance: string; observed_at: string };
    expect(row.ok).toBe(1);
    expect(row.raw_content).toBe(GOOD_PAGE);
    expect(row.raw_hash).toHaveLength(64);
    expect(row.provenance).toBe('live');
    expect(row.observed_at).toBe('2026-08-18T12:00:00.000Z');
  });

  it('skips a source that is not yet due', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T18:00:00.000Z') });

    expect(stats.attempted).toBe(0);
    const count = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('writes a row with NULL raw_content when the hash repeats', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-19T12:00:00.000Z') });

    expect(stats.unchanged).toBe(1);
    expect(stats.stored).toBe(0);

    const rows = db.prepare('SELECT raw_content FROM snapshots ORDER BY id').all() as
      { raw_content: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.raw_content).toBe(GOOD_PAGE);
    expect(rows[1]!.raw_content).toBeNull();
  });

  it('stores raw content again when the page genuinely changes', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const changed = GOOD_PAGE.replace('$20', '$24');
    const stats = await collect(db, {}, { fetcher: async () => ok(changed), now: at('2026-08-19T12:00:00.000Z') });

    expect(stats.stored).toBe(1);
    const rows = db.prepare('SELECT raw_content FROM snapshots ORDER BY id').all() as
      { raw_content: string | null }[];
    expect(rows[1]!.raw_content).toBe(changed);
  });

  it('records a failed fetch without raw content and never overwrites good data', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, {
      fetcher: async () => fail(503, 'HTTP 503'),
      now: at('2026-08-19T12:00:00.000Z'),
    });

    expect(stats.failed).toBe(1);

    const rows = db.prepare('SELECT ok, raw_content, error, http_status FROM snapshots ORDER BY id').all() as
      { ok: number; raw_content: string | null; error: string | null; http_status: number | null }[];
    expect(rows[0]!.raw_content).toBe(GOOD_PAGE);
    expect(rows[1]!.ok).toBe(0);
    expect(rows[1]!.raw_content).toBeNull();
    expect(rows[1]!.error).toBe('HTTP 503');
    expect(rows[1]!.http_status).toBe(503);
  });

  it('marks the source degraded when the canary string is missing', async () => {
    const stats = await collect(db, {}, {
      fetcher: async () => ok('<html><h2>Pro</h2><p>$20</p></html>'),
      now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.degraded).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toMatch(/canary/i);
  });

  it('marks the source degraded when no price-like text is present', async () => {
    const stats = await collect(db, {}, {
      fetcher: async () => ok('<html><h2>Enterprise</h2><p>Talk to us</p></html>'),
      now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.degraded).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toMatch(/price/i);
  });

  it('clears degraded_reason on the next healthy fetch', async () => {
    await collect(db, {}, { fetcher: async () => ok('<html>broken</html>'), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-19T12:00:00.000Z') });

    expect(stats.cleared).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toBeNull();
  });

  it('honours --limit', async () => {
    seedCompetitors(db, [
      ...CONFIG,
      { slug: 'beta', name: 'Beta', homepage: 'https://beta.test',
        sources: [{ kind: 'pricing', url: 'https://beta.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
    ]);

    const stats = await collect(db, { limit: 1 }, {
      fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.attempted).toBe(1);
  });

  it('writes nothing in dry-run mode', async () => {
    const stats = await collect(db, { dryRun: true }, {
      fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.attempted).toBe(1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('leaves a completed run row behind', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const row = db.prepare("SELECT state, ok FROM runs WHERE kind = 'collect'").get() as
      { state: string; ok: number };
    expect(row).toEqual({ state: 'ok', ok: 1 });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test tests/collect.test.ts`
Expected: FAIL — cannot resolve `../src/workflow/collect.js`.

- [ ] **Step 7: Write `src/workflow/collect.ts`**

```ts
import type { DB } from '../ops/db.js';
import { finishRun, acquireRun } from '../ops/runs.js';
import { politeFetch, type FetchResult } from '../tools/fetch.js';
import { sha256 } from '../tools/hash.js';

export interface CollectOptions { limit?: number; dryRun?: boolean }

export interface CollectStats {
  attempted: number;
  stored: number;
  unchanged: number;
  failed: number;
  degraded: number;
  cleared: number;
}

export interface CollectDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  now?: () => Date;
}

interface DueSource {
  id: number;
  url: string;
  canary_string: string;
  degraded_reason: string | null;
}

/** A page with no currency-and-digit anywhere is not a pricing page any more. */
const PRICE_PATTERN = /[$€£]\s?\d/;

function healthProblem(body: string, canary: string): string | null {
  if (!body.includes(canary)) {
    return `canary string "${canary}" missing — the page may have been redesigned`;
  }
  if (!PRICE_PATTERN.test(body)) {
    return 'no price-like text found — the page may no longer publish prices';
  }
  return null;
}

/**
 * Spec 5.2: queries the DB for outstanding work rather than holding state.
 * Spec 11 and 7.2 govern what gets written; nothing here ever UPDATEs a
 * snapshot, so a failure can never overwrite a good one.
 */
export async function collect(
  db: DB,
  opts: CollectOptions = {},
  deps: CollectDeps = {}
): Promise<CollectStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? ((url: string) => politeFetch(url));
  const stats: CollectStats = {
    attempted: 0, stored: 0, unchanged: 0, failed: 0, degraded: 0, cleared: 0,
  };

  const runId = acquireRun(db, 'collect', { now });

  try {
    const nowIso = now().toISOString();

    const due = db.prepare(`
      SELECT s.id, s.url, s.canary_string, s.degraded_reason
      FROM sources s
      WHERE s.active = 1
        AND NOT EXISTS (
          SELECT 1 FROM snapshots snap
          WHERE snap.source_id = s.id
            -- Both sides go through datetime() deliberately. We store ISO 8601
            -- with a 'T' and a 'Z'; SQLite's datetime() emits a space and no
            -- zone. Comparing the two as raw strings makes 'T' > ' ' decide
            -- same-day ties, so a source would look freshly fetched forever.
            AND datetime(snap.fetched_at) > datetime(?, '-' || s.cadence_hours || ' hours')
        )
      ORDER BY s.id
      ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
    `).all(nowIso) as DueSource[];

    const insertSnapshot = db.prepare(`
      INSERT INTO snapshots
        (source_id, observed_at, fetched_at, ok, http_status, error,
         raw_content, raw_hash, normalized_hash, provenance)
      VALUES (@sourceId, @observedAt, @fetchedAt, @ok, @httpStatus, @error,
              @rawContent, @rawHash, NULL, 'live')
    `);
    const findHash = db.prepare(
      'SELECT id FROM snapshots WHERE source_id = ? AND raw_hash = ? LIMIT 1'
    );
    const setDegraded = db.prepare('UPDATE sources SET degraded_reason = ? WHERE id = ?');

    for (const source of due) {
      stats.attempted += 1;
      const result = await fetcher(source.url);
      const stamp = now().toISOString();

      if (opts.dryRun) continue;

      if (!result.ok || result.body === null) {
        stats.failed += 1;
        insertSnapshot.run({
          sourceId: source.id, observedAt: stamp, fetchedAt: stamp,
          ok: 0, httpStatus: result.httpStatus, error: result.error,
          rawContent: null, rawHash: null,
        });
        continue;
      }

      const problem = healthProblem(result.body, source.canary_string);
      if (problem) {
        stats.degraded += 1;
        setDegraded.run(problem, source.id);
      } else if (source.degraded_reason !== null) {
        stats.cleared += 1;
        setDegraded.run(null, source.id);
      }

      const rawHash = sha256(result.body);
      const seen = findHash.get(source.id, rawHash) as { id: number } | undefined;

      if (seen) stats.unchanged += 1;
      else stats.stored += 1;

      insertSnapshot.run({
        sourceId: source.id, observedAt: stamp, fetchedAt: stamp,
        ok: 1, httpStatus: result.httpStatus, error: null,
        rawContent: seen ? null : result.body, rawHash,
      });
    }

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test tests/collect.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 9: Add the `collect` command to `src/cli.ts`**

Insert after the `seed` command block:

```ts
program
  .command('collect')
  .description('fetch every source that is past its cadence')
  .option('--limit <n>', 'process at most n sources', v => Number(v))
  .option('--dry-run', 'fetch but write nothing')
  .action(async (options: { limit?: number; dryRun?: boolean }) => {
    const { collect } = await import('./workflow/collect.js');
    const db = openDb(dbPath());
    const stats = await collect(db, { limit: options.limit, dryRun: options.dryRun });
    console.log(
      `Checked ${stats.attempted}: ${stats.stored} new, ${stats.unchanged} unchanged, ` +
      `${stats.failed} failed, ${stats.degraded} degraded, ${stats.cleared} recovered.`
    );
    db.close();
  });
```

- [ ] **Step 10: Verify against the real six sources**

Run: `pnpm bw migrate && pnpm bw seed && pnpm bw collect`
Expected: `Checked 6: 6 new, 0 unchanged, 0 failed, 0 degraded, 0 recovered.` — takes roughly a minute because of per-host spacing. Any degraded source means its canary needs revisiting in `competitors.public.ts`.

- [ ] **Step 11: Verify the hash gate on a second run**

Run: `pnpm bw collect`
Expected: `Checked 0: ...` — nothing is due for 24 hours. To prove dedup works now, run `sqlite3 data/bellwether.db "SELECT source_id, length(raw_content) FROM snapshots;"` and confirm six rows with non-null content.

- [ ] **Step 12: Commit**

```bash
git add src/ops/runs.ts src/workflow/collect.ts src/cli.ts tests/runs.test.ts tests/collect.test.ts
git commit -m "feat: collect workflow with run lock, hash gate, dedup, and canary health"
```

---

## Task 6: Guarded export

**Files:**
- Create: `src/workflow/export.ts`
- Modify: `src/cli.ts` — add the `export` command
- Test: `tests/export.test.ts`

**Interfaces:**
- Consumes: `openDb`, `migrate`, `seedCompetitors`, `collect`.
- Produces:
  - `exportData(db: DB, outDir: string, deps?: ExportDeps): ExportStats`
  - `class ExportGuardError extends Error`
  - `interface ExportStats { files: string[]; competitors: number; healthySources: number; totalSources: number }`
  - JSON contracts `board.json` and `status.json`, consumed by the web app in Task 8.

- [ ] **Step 1: Write the failing test**

`tests/export.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { collect } from '../src/workflow/collect.js';
import { ExportGuardError, exportData } from '../src/workflow/export.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let out: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [
  { slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
    sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
  { slug: 'beta', name: 'Beta', homepage: 'https://beta.test',
    sources: [{ kind: 'pricing', url: 'https://beta.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
];

const GOOD = '<html><h2>Pro</h2><p>$20</p><h2>Enterprise</h2></html>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-export-'));
  out = join(dir, 'data');
  mkdirSync(out, { recursive: true });
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function read(name: string): any {
  return JSON.parse(readFileSync(join(out, name), 'utf8'));
}

async function populate() {
  await collect(db, {}, {
    fetcher: async () => ({ ok: true, httpStatus: 200, body: GOOD, error: null }),
    now: () => new Date('2026-08-18T12:00:00.000Z'),
  });
}

describe('exportData', () => {
  it('writes board.json and status.json', async () => {
    await populate();
    const stats = exportData(db, out);

    expect(stats.files.sort()).toEqual(['board.json', 'status.json']);
    expect(stats.competitors).toBe(2);
  });

  it('describes each competitor and source in board.json', async () => {
    await populate();
    exportData(db, out);
    const board = read('board.json');

    expect(board.competitors).toHaveLength(2);
    const acme = board.competitors.find((c: any) => c.slug === 'acme');
    expect(acme.name).toBe('Acme');
    expect(acme.sources[0].state).toBe('ok');
    expect(acme.sources[0].last_ok_at).toBe('2026-08-18T12:00:00.000Z');
    expect(acme.sources[0].distinct_states).toBe(1);
  });

  it('reports a degraded source as degraded', async () => {
    await collect(db, {}, {
      fetcher: async () => ({ ok: true, httpStatus: 200, body: '<html>nothing</html>', error: null }),
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    exportData(db, out);

    const board = read('board.json');
    expect(board.competitors[0].sources[0].state).toBe('degraded');
    expect(board.competitors[0].sources[0].degraded_reason).toMatch(/canary/i);
  });

  it('reports a source whose last fetch failed as failing', async () => {
    await collect(db, {}, {
      fetcher: async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' }),
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    exportData(db, out);

    expect(read('board.json').competitors[0].sources[0].state).toBe('failing');
  });

  it('counts healthy sources in status.json', async () => {
    await populate();
    exportData(db, out);
    const status = read('status.json');

    expect(status.total_sources).toBe(2);
    expect(status.healthy_sources).toBe(2);
    expect(status.cost_micros_month).toBe(0);
  });

  it('refuses to publish when there are no competitors', () => {
    const empty = openDb(join(dir, 'empty.db'));
    migrate(empty, join(process.cwd(), 'migrations'));

    expect(() => exportData(empty, out)).toThrow(ExportGuardError);
    empty.close();
  });

  it('refuses to publish fewer competitors than last time', async () => {
    await populate();
    exportData(db, out);

    db.prepare("UPDATE competitors SET active = 0 WHERE slug = 'beta'").run();
    expect(() => exportData(db, out)).toThrow(/fewer competitors/i);
  });

  it('refuses to publish a file that shrank by more than half', async () => {
    await populate();
    exportData(db, out);
    writeFileSync(join(out, 'status.json'), JSON.stringify({ padding: 'x'.repeat(20_000) }));

    expect(() => exportData(db, out)).toThrow(/shrank/i);
  });

  it('leaves the previous files untouched when a guard trips', async () => {
    await populate();
    exportData(db, out);
    const before = readFileSync(join(out, 'board.json'), 'utf8');

    db.prepare("UPDATE competitors SET active = 0 WHERE slug = 'beta'").run();
    expect(() => exportData(db, out)).toThrow();

    expect(readFileSync(join(out, 'board.json'), 'utf8')).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/export.test.ts`
Expected: FAIL — cannot resolve `../src/workflow/export.js`.

- [ ] **Step 3: Write `src/workflow/export.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../ops/db.js';
import { acquireRun, finishRun } from '../ops/runs.js';

export class ExportGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportGuardError';
  }
}

export interface ExportStats {
  files: string[];
  competitors: number;
  healthySources: number;
  totalSources: number;
}

export interface ExportDeps { now?: () => Date; withRun?: boolean }

export type SourceState = 'ok' | 'degraded' | 'failing' | 'pending';

interface SourceRow {
  source_id: number;
  slug: string;
  name: string;
  homepage: string;
  kind: string;
  url: string;
  degraded_reason: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_ok_flag: number | null;
  distinct_states: number;
}

function stateOf(row: SourceRow): SourceState {
  if (row.last_checked_at === null) return 'pending';
  if (row.last_ok_flag === 0) return 'failing';
  if (row.degraded_reason !== null) return 'degraded';
  return 'ok';
}

/**
 * Spec 15.7: the published artifact is the deliverable, and overwriting it with
 * nothing is the one unrecoverable failure. Every file is written to .tmp first
 * and only renamed after every guard passes, so a trip leaves the last good
 * publish completely untouched.
 */
export function exportData(db: DB, outDir: string, deps: ExportDeps = {}): ExportStats {
  const now = (deps.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  mkdirSync(outDir, { recursive: true });

  const rows = db.prepare(`
    SELECT
      s.id AS source_id, c.slug, c.name, c.homepage, s.kind, s.url, s.degraded_reason,
      (SELECT MAX(fetched_at) FROM snapshots WHERE source_id = s.id) AS last_checked_at,
      (SELECT MAX(fetched_at) FROM snapshots WHERE source_id = s.id AND ok = 1) AS last_ok_at,
      (SELECT ok FROM snapshots WHERE source_id = s.id ORDER BY fetched_at DESC, id DESC LIMIT 1) AS last_ok_flag,
      (SELECT COUNT(DISTINCT raw_hash) FROM snapshots WHERE source_id = s.id AND raw_hash IS NOT NULL) AS distinct_states
    FROM sources s
    JOIN competitors c ON c.id = s.competitor_id
    WHERE s.active = 1 AND c.active = 1
    ORDER BY c.name, s.kind
  `).all() as SourceRow[];

  const bySlug = new Map<string, { slug: string; name: string; homepage: string; sources: unknown[] }>();
  let healthy = 0;

  for (const row of rows) {
    const state = stateOf(row);
    if (state === 'ok') healthy += 1;

    if (!bySlug.has(row.slug)) {
      bySlug.set(row.slug, { slug: row.slug, name: row.name, homepage: row.homepage, sources: [] });
    }
    bySlug.get(row.slug)!.sources.push({
      kind: row.kind,
      url: row.url,
      state,
      last_checked_at: row.last_checked_at,
      last_ok_at: row.last_ok_at,
      distinct_states: row.distinct_states,
      degraded_reason: row.degraded_reason,
    });
  }

  const competitors = [...bySlug.values()];

  const lastRun = db.prepare(
    'SELECT kind, started_at, ended_at, state FROM runs ORDER BY id DESC LIMIT 1'
  ).get() as { kind: string; started_at: string; ended_at: string | null; state: string } | undefined;

  const board = { generated_at: generatedAt, competitors };
  const status = {
    generated_at: generatedAt,
    total_sources: rows.length,
    healthy_sources: healthy,
    sources: rows.map(r => ({
      slug: r.slug, kind: r.kind, state: stateOf(r),
      last_ok_at: r.last_ok_at, degraded_reason: r.degraded_reason,
    })),
    last_run: lastRun ?? null,
    // M2 replaces this with a real sum over extractions and digests (spec 7.1).
    cost_micros_month: 0,
  };

  const payloads: Record<string, unknown> = { 'board.json': board, 'status.json': status };

  // ---- Guards (spec 15.7). All must pass before anything is renamed. -----
  if (competitors.length === 0) {
    throw new ExportGuardError(
      'Refusing to publish: no active competitors found. Run `bellwether seed` first.'
    );
  }

  const previousBoardPath = join(outDir, 'board.json');
  if (existsSync(previousBoardPath)) {
    const previous = JSON.parse(readFileSync(previousBoardPath, 'utf8')) as { competitors?: unknown[] };
    const previousCount = previous.competitors?.length ?? 0;
    if (competitors.length < previousCount) {
      throw new ExportGuardError(
        `Refusing to publish fewer competitors than the last publish ` +
        `(${competitors.length} now, ${previousCount} before). ` +
        `If this is intentional, delete ${previousBoardPath} and export again.`
      );
    }
  }

  const staged: { final: string; tmp: string }[] = [];
  try {
  for (const [name, payload] of Object.entries(payloads)) {
    const serialized = JSON.stringify(payload, null, 2);
    const finalPath = join(outDir, name);

    if (existsSync(finalPath)) {
      const previousSize = readFileSync(finalPath, 'utf8').length;
      if (previousSize > 0 && serialized.length < previousSize * 0.5) {
        throw new ExportGuardError(
          `Refusing to publish: ${name} shrank from ${previousSize} to ${serialized.length} bytes. ` +
          `A file losing more than half its content usually means a query broke.`
        );
      }
    }

    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, serialized);
    JSON.parse(readFileSync(tmpPath, 'utf8'));
    staged.push({ final: finalPath, tmp: tmpPath });
  }

  for (const { final, tmp } of staged) renameSync(tmp, final);
  } catch (err) {
    // A tripped guard must leave no trace. Remove anything already staged so a
    // later run never renames a half-written set.
    for (const { tmp } of staged) { try { unlinkSync(tmp); } catch { /* already gone */ } }
    throw err;
  }

  return {
    files: Object.keys(payloads),
    competitors: competitors.length,
    healthySources: healthy,
    totalSources: rows.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/export.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add the `export` command to `src/cli.ts`**

Insert after the `collect` command block:

```ts
program
  .command('export')
  .description('rebuild the published JSON from current database state')
  .action(async () => {
    const { exportData } = await import('./workflow/export.js');
    const db = openDb(dbPath());
    const outDir = resolve(process.env.BELLWETHER_EXPORT_DIR ?? './web/public/data');
    const stats = exportData(db, outDir);
    console.log(
      `Wrote ${stats.files.join(', ')} to ${outDir} — ` +
      `${stats.competitors} competitors, ${stats.healthySources}/${stats.totalSources} sources healthy.`
    );
    db.close();
  });
```

- [ ] **Step 6: Verify against real data**

Run: `pnpm bw export && cat web/public/data/status.json`
Expected: valid JSON, `total_sources` 6, `healthy_sources` 6.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/export.ts src/cli.ts tests/export.test.ts web/public/data
git commit -m "feat: guarded export that cannot blank the published site"
```

---

## Task 7: `bellwether doctor`

**Files:**
- Create: `src/ops/doctor.ts`
- Modify: `src/cli.ts` — add the `doctor` command
- Test: `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `openDb`, `migrate`, `politeFetch`.
- Produces:
  - `runDoctor(deps: DoctorDeps): Promise<CheckResult[]>`
  - `interface CheckResult { name: string; status: 'ok' | 'fail' | 'pending'; detail: string; fix?: string }`

M1 implements spec 22.3 checks 1, 2, 4, and 5. Checks 3 (Anthropic key), 6 (Telegram), and 7 (B2) return `pending` with the milestone that adds them — an honest placeholder in output, not an unimplemented branch.

- [ ] **Step 1: Write the failing test**

`tests/doctor.test.ts`:

```ts
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

  it('fails the environment check on an unfilled placeholder', async () => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/doctor.test.ts`
Expected: FAIL — cannot resolve `../src/ops/doctor.js`.

- [ ] **Step 3: Write `src/ops/doctor.ts`**

```ts
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
  gitPush?: () => Promise<{ ok: boolean; detail: string }>;
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
    const push = await deps.gitPush();
    results.push(push.ok
      ? { name: 'git push', status: 'ok', detail: push.detail }
      : {
          name: 'git push', status: 'fail', detail: push.detail,
          fix: 'Check the deploy key: `git push --dry-run origin main`. ' +
               'The key needs write access to the repo Vercel builds from.',
        });
  }

  // 5. Sources
  if (schemaOk) {
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
  }

  // 6 & 7 — M5
  results.push({ name: 'telegram alerts', status: 'pending', detail: 'not checked yet; alerts arrive in M5' });
  results.push({ name: 'backup target', status: 'pending', detail: 'not checked yet; B2 backup arrives in M5' });

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/doctor.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the `doctor` command to `src/cli.ts`**

Insert after the `export` command block:

```ts
program
  .command('doctor')
  .description('check that everything needed to run is present and working')
  .action(async () => {
    const { runDoctor } = await import('./ops/doctor.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const db = openDb(dbPath());
    const results = await runDoctor({
      db,
      env: process.env,
      gitPush: async () => {
        try {
          await run('git', ['push', '--dry-run', 'origin', 'HEAD'], { cwd: ROOT });
          return { ok: true, detail: 'deploy key can push to origin' };
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
        }
      },
    });
    db.close();

    const mark = { ok: '  ok  ', fail: ' FAIL ', pending: '  --  ' } as const;
    for (const r of results) {
      console.log(`[${mark[r.status]}] ${r.name.padEnd(24)} ${r.detail}`);
      if (r.fix) console.log(`${' '.repeat(11)}fix: ${r.fix}`);
    }

    const failures = results.filter(r => r.status === 'fail').length;
    console.log(
      failures === 0
        ? '\nAll checks passed. Run `docker compose up -d` to start collecting.'
        : `\n${failures} check${failures === 1 ? '' : 's'} need attention before this will run unattended.`
    );
    process.exit(failures === 0 ? 0 : 1);
  });
```

- [ ] **Step 6: Verify the command runs end to end**

Run: `pnpm bw doctor`
Expected: `ok` on environment, schema, git push, and all six sources; `--` on the three M2/M5 checks; exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/ops/doctor.ts src/cli.ts tests/doctor.test.ts
git commit -m "feat: bellwether doctor preflight checks"
```

---

## Task 8: Web app shell and design tokens

**Files:**
- Create: `web/package.json`, `web/next.config.ts`, `web/tsconfig.json`, `web/postcss.config.mjs`
- Create: `web/app/globals.css`, `web/app/layout.tsx`
- Create: `web/lib/types.ts`, `web/lib/data.ts`

`web/` is a standalone Next.js app with its own `package.json`; Vercel's project root is `web/`. That avoids monorepo configuration entirely.

**Interfaces:**
- Consumes: `board.json` and `status.json` written by Task 6.
- Produces:
  - `interface Board`, `interface Status`, `type SourceState` (mirroring the export contract)
  - `loadBoard(): Board`, `loadStatus(): Status` — read at build time
  - CSS custom properties: `--color-surface`, `--color-surface-raised`, `--color-ink`, `--color-ink-secondary`, `--color-ink-muted`, `--color-rule`, `--color-rule-strong`, `--color-state-ok`, `--color-state-degraded`, `--color-state-failing`

- [ ] **Step 1: Scaffold the Next.js app**

```bash
cd "/Users/ncomeaux/VsCode/Competitor Watcher"
mkdir -p web/app web/lib web/components web/public/data
cd web
pnpm init
pnpm add next react react-dom
pnpm add -D typescript @types/react @types/node tailwindcss @tailwindcss/postcss
cd ..
```

- [ ] **Step 2: Write `web/package.json` scripts**

Keep the resolved dependency versions; replace the surrounding fields.

```json
{
  "name": "bellwether-web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

- [ ] **Step 3: Write `web/next.config.ts`**

```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default config;
```

- [ ] **Step 4: Write `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Write `web/postcss.config.mjs`**

```js
export default {
  plugins: { '@tailwindcss/postcss': {} },
};
```

- [ ] **Step 6: Write `web/app/globals.css`**

Spec 14.3. Light is the base palette; dark is a **selected** set of steps against the dark surface, not an inversion. Status colours are conventional on purpose — accessibility beats novelty for state — but desaturated to sit inside the ledger direction.

```css
@import "tailwindcss";

@theme {
  --color-surface: #f7f8fa;
  --color-surface-raised: #ffffff;
  --color-ink: #16202b;
  --color-ink-secondary: #4a5a6a;
  --color-ink-muted: #7c8a99;
  --color-rule: #dce2e8;
  --color-rule-strong: #b8c2cc;
  --color-state-ok: #1f7a5c;
  --color-state-degraded: #9a6b00;
  --color-state-failing: #b03a2e;

  --font-display: var(--font-bricolage), ui-sans-serif, system-ui, sans-serif;
  --font-sans: var(--font-public-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-plex-mono), ui-monospace, SFMono-Regular, monospace;
}

/* Tailwind v4's @theme must be top level — it cannot nest inside @media.
   Dark mode therefore overrides the emitted custom properties directly on
   :root, which every generated utility already reads through var(). These are
   selected steps against the dark surface, not an inversion of the light set
   (spec 14.3). */
@media (prefers-color-scheme: dark) {
  :root {
    --color-surface: #10161c;
    --color-surface-raised: #18202a;
    --color-ink: #e8edf2;
    --color-ink-secondary: #a3b1bf;
    --color-ink-muted: #6e7f8f;
    --color-rule: #263341;
    --color-rule-strong: #3a4a5a;
    --color-state-ok: #4fd1a5;
    --color-state-degraded: #e0a33a;
    --color-state-failing: #f07167;
  }
}

html {
  background: var(--color-surface);
  color: var(--color-ink);
}

body {
  font-family: var(--font-sans);
  /* Spec 14.3: tabular numerals everywhere, including inline in body copy.
     In a price archive, digits that do not line up are a defect. */
  font-variant-numeric: tabular-nums;
}

:focus-visible {
  outline: 2px solid var(--color-ink);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 7: Write `web/lib/types.ts`**

These mirror the export contract from Task 6 exactly. If Task 6's shape changes, this file changes with it.

```ts
export type SourceState = 'ok' | 'degraded' | 'failing' | 'pending';

export interface BoardSource {
  kind: string;
  url: string;
  state: SourceState;
  last_checked_at: string | null;
  last_ok_at: string | null;
  distinct_states: number;
  degraded_reason: string | null;
}

export interface BoardCompetitor {
  slug: string;
  name: string;
  homepage: string;
  sources: BoardSource[];
}

export interface Board {
  generated_at: string;
  competitors: BoardCompetitor[];
}

export interface Status {
  generated_at: string;
  total_sources: number;
  healthy_sources: number;
  sources: { slug: string; kind: string; state: SourceState; last_ok_at: string | null; degraded_reason: string | null }[];
  last_run: { kind: string; started_at: string; ended_at: string | null; state: string } | null;
  cost_micros_month: number;
}
```

- [ ] **Step 8: Write `web/lib/data.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board, Status } from './types.js';

const DATA_DIR = join(process.cwd(), 'public', 'data');

function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T;
  } catch {
    // A missing file means the pipeline has not exported yet. The page renders
    // its empty state rather than failing the build (spec 14.3 copy rules).
    return fallback;
  }
}

export function loadBoard(): Board {
  return read<Board>('board.json', { generated_at: '', competitors: [] });
}

export function loadStatus(): Status {
  return read<Status>('status.json', {
    generated_at: '', total_sources: 0, healthy_sources: 0,
    sources: [], last_run: null, cost_micros_month: 0,
  });
}
```

- [ ] **Step 9: Write `web/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import { Bricolage_Grotesque, IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import './globals.css';

const bricolage = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });
const publicSans = Public_Sans({ subsets: ['latin'], variable: '--font-public-sans', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://bellwether.cmxlogic.com'),
  title: 'Bellwether — the open archive of developer-infrastructure pricing',
  description:
    'Every pricing change across developer infrastructure, recorded daily, confirmed before publishing, and free to cite.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${publicSans.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-surface text-ink antialiased">
        <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-16">
          {children}
          <footer className="mt-20 border-t border-rule pt-6 text-sm text-ink-muted">
            <p>
              Bellwether records public pricing pages. It publishes extracted facts and its own
              analysis, never the pages themselves.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 10: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/next.config.ts web/tsconfig.json \
        web/postcss.config.mjs web/app/globals.css web/app/layout.tsx web/lib
git commit -m "feat(web): Next.js static shell with ledger design tokens"
```

---

## Task 9: The board view

**Files:**
- Create: `web/components/StateBadge.tsx`, `web/components/Stamp.tsx`, `web/components/BoardTable.tsx`
- Create: `web/app/page.tsx`

**Interfaces:**
- Consumes: `loadBoard`, `loadStatus`, `Board`, `Status`, `SourceState` (Task 8).
- Produces: the rendered home page. No exports other tasks depend on.

- [ ] **Step 1: Write `web/components/StateBadge.tsx`**

Spec 14.3: status is never colour-alone — every badge carries a glyph and a word.

```tsx
import type { SourceState } from '@/lib/types';

const PRESENTATION: Record<SourceState, { label: string; glyph: string; className: string }> = {
  ok:       { label: 'Verified',  glyph: '●', className: 'text-state-ok' },
  degraded: { label: 'Degraded',  glyph: '◐', className: 'text-state-degraded' },
  failing:  { label: 'Failing',   glyph: '○', className: 'text-state-failing' },
  pending:  { label: 'Not yet checked', glyph: '·', className: 'text-ink-muted' },
};

export function StateBadge({ state }: { state: SourceState }) {
  const { label, glyph, className } = PRESENTATION[state];
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-sm ${className}`}>
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  );
}
```

- [ ] **Step 2: Write `web/components/Stamp.tsx`**

A ledger records exact instants. Rendered server-side so the static export is deterministic — no hydration mismatch, no client clock.

```tsx
export function Stamp({ iso, empty = 'never' }: { iso: string | null; empty?: string }) {
  if (!iso) return <span className="font-mono text-ink-muted">{empty}</span>;

  const date = new Date(iso);
  const display = date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return (
    <time dateTime={iso} className="font-mono text-sm text-ink-secondary">
      {display}
    </time>
  );
}
```

- [ ] **Step 3: Write `web/components/BoardTable.tsx`**

Semantic `<table>` per the quality floor, and it scrolls inside its own container rather than making the page scroll sideways.

```tsx
import type { BoardCompetitor } from '@/lib/types';
import { StateBadge } from './StateBadge';
import { Stamp } from './Stamp';

export function BoardTable({ competitors }: { competitors: BoardCompetitor[] }) {
  if (competitors.length === 0) {
    return (
      <div className="rounded border border-rule bg-surface-raised p-8">
        <p className="text-ink">Nothing recorded yet.</p>
        <p className="mt-2 text-ink-secondary">
          Run <code className="font-mono text-ink">bellwether collect</code> to take the first
          observation, then <code className="font-mono text-ink">bellwether export</code> to publish it.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Every watched source, its current state, and when it was last verified
        </caption>
        <thead>
          <tr className="border-b border-rule-strong">
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Company</th>
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Source</th>
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">State</th>
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Last verified</th>
            <th scope="col" className="py-3 text-right text-sm font-medium text-ink-secondary">
              States seen
            </th>
          </tr>
        </thead>
        <tbody>
          {competitors.flatMap(c =>
            c.sources.map(s => (
              <tr key={`${c.slug}-${s.kind}`} className="border-b border-rule align-top">
                <th scope="row" className="py-4 pr-4 font-display text-lg font-medium text-ink">
                  {c.name}
                </th>
                <td className="py-4 pr-4">
                  <a
                    href={s.url}
                    rel="noopener nofollow"
                    className="font-mono text-sm text-ink-secondary underline decoration-rule-strong underline-offset-4 hover:text-ink"
                  >
                    {s.kind}
                  </a>
                  {s.degraded_reason && (
                    <p className="mt-1 max-w-xs text-sm text-state-degraded">{s.degraded_reason}</p>
                  )}
                </td>
                <td className="py-4 pr-4"><StateBadge state={s.state} /></td>
                <td className="py-4 pr-4"><Stamp iso={s.last_ok_at} /></td>
                <td className="py-4 text-right font-mono text-sm text-ink-secondary">
                  {s.distinct_states}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Write `web/app/page.tsx`**

The hero is the thesis: this is a record, and the record's size is the claim. No marketing block, no gradient stat card.

```tsx
import { BoardTable } from '@/components/BoardTable';
import { Stamp } from '@/components/Stamp';
import { loadBoard, loadStatus } from '@/lib/data';

export default function HomePage() {
  const board = loadBoard();
  const status = loadStatus();

  return (
    <main>
      <header className="border-b border-rule-strong pb-10">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Bellwether
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-secondary">
          The open archive of developer-infrastructure pricing. Every watched page is checked
          daily; every change is confirmed by a second observation before it is published.
        </p>

        <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 font-mono text-sm">
          <div>
            <dt className="text-ink-muted">Sources watched</dt>
            <dd className="mt-1 text-2xl text-ink">{status.total_sources}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Verified now</dt>
            <dd className="mt-1 text-2xl text-ink">
              {status.healthy_sources}<span className="text-ink-muted">/{status.total_sources}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Spend this month</dt>
            <dd className="mt-1 text-2xl text-ink">
              ${(status.cost_micros_month / 1_000_000).toFixed(2)}
            </dd>
          </div>
        </dl>
      </header>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">The record</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Prices and change history arrive next. Today this page reports what Bellwether is
          watching and whether each source is still readable.
        </p>
        <div className="mt-6">
          <BoardTable competitors={board.competitors} />
        </div>
      </section>

      <section className="mt-12 border-t border-rule pt-6">
        <p className="text-sm text-ink-muted">
          Last published <Stamp iso={status.generated_at || null} empty="not yet" />.
          {status.last_run && (
            <> Last <span className="font-mono">{status.last_run.kind}</span> run finished{' '}
              <Stamp iso={status.last_run.ended_at} empty="still running" />.</>
          )}
        </p>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Build and look at it**

```bash
cd web && pnpm build && cd ..
```
Expected: build succeeds, `web/out/index.html` exists.

Then run `cd web && pnpm dev` and open `http://localhost:3000`. Check by eye:
- All six companies listed with green `● Verified` badges
- Numerals aligned in the "States seen" column
- Toggle your OS to dark mode — the palette changes and text stays readable
- Narrow the window to 375px — the table scrolls inside its container, the page does not
- Tab through the links — focus outlines are visible

- [ ] **Step 6: Commit**

```bash
git add web/components web/app/page.tsx
git commit -m "feat(web): board view showing every source and its verification state"
```

---

## Task 10: Docker runtime

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`

**Interfaces:**
- Consumes: the CLI from Tasks 2–7.
- Produces: a container that runs `bellwether` commands with the archive on a mounted volume.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
web/node_modules
web/.next
web/out
data
.git
.env
```

- [ ] **Step 2: Write `Dockerfile`**

`better-sqlite3` is a native module, so the build stage needs a toolchain even though the runtime does not.

```dockerfile
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
# python3/make/g++ are required to compile better-sqlite3 from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY migrations ./migrations
COPY src ./src

ENV BELLWETHER_DB=/data/bellwether.db
ENV BELLWETHER_EXPORT_DIR=/app/web/public/data
ENV TZ=America/Chicago

ENTRYPOINT ["pnpm", "bw"]
CMD ["doctor"]
```

- [ ] **Step 3: Write `docker-compose.yml`**

One service, as spec 12.1 requires — backfill is a one-shot command, not its own container.

```yaml
services:
  bellwether:
    build: .
    container_name: bellwether
    restart: unless-stopped
    env_file: .env
    environment:
      BELLWETHER_DB: /data/bellwether.db
      BELLWETHER_EXPORT_DIR: /app/web/public/data
      TZ: America/Chicago
    volumes:
      - ./data:/data
      - ./web/public/data:/app/web/public/data
    entrypoint: ["/bin/sh", "-c"]
    command: >
      "pnpm bw migrate && pnpm bw seed && tail -f /dev/null"
    healthcheck:
      # Spec 6: report real pipeline health, not merely that the process exists.
      # Unhealthy until a step has succeeded in the last 26 hours.
      test: ["CMD", "node", "-e", "const D=require('better-sqlite3');const db=new D('/data/bellwether.db',{readonly:true});const r=db.prepare(\"SELECT COUNT(*) n FROM runs WHERE state='ok' AND ended_at > datetime('now','-26 hours')\").get();process.exit(r.n>0?0:1)"]
      interval: 5m
      timeout: 10s
      retries: 3
      start_period: 1m
```

- [ ] **Step 4: Build and verify**

```bash
docker compose build
docker compose up -d
docker compose exec bellwether pnpm bw doctor
docker compose exec bellwether pnpm bw collect
docker compose exec bellwether pnpm bw export
```
Expected: doctor is green, collect reports six sources checked, export writes both files into the mounted `web/public/data`.

- [ ] **Step 5: Verify the healthcheck reflects reality**

Run: `docker inspect --format '{{.State.Health.Status}}' bellwether`
Expected: `healthy` after the successful collect. (Before any collect it reports `unhealthy`, which is correct — nothing has succeeded yet.)

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "feat: Docker runtime with a healthcheck on pipeline freshness"
```

---

## Task 11: Publish

**Files:**
- Create: `README.md`
- Modify: `src/workflow/export.ts` — add commit-and-push
- Modify: `src/cli.ts` — add `--publish` to the export command
- Test: `tests/publish.test.ts`

**Interfaces:**
- Consumes: `exportData` (Task 6).
- Produces: `publish(repoRoot: string, message: string, deps?: PublishDeps): Promise<{ pushed: boolean; detail: string }>`

- [ ] **Step 1: Write the failing test**

`tests/publish.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildCommitMessage } from '../src/workflow/export.js';

describe('buildCommitMessage', () => {
  it('uses the fixed format so git log reads as a market changelog', () => {
    const message = buildCommitMessage({ changes: 3, sources: 6, date: '2026-08-18' });
    expect(message).toBe('data: 3 changes, 6 sources, 2026-08-18');
  });

  it('pluralises correctly at one', () => {
    expect(buildCommitMessage({ changes: 1, sources: 1, date: '2026-08-18' }))
      .toBe('data: 1 change, 1 source, 2026-08-18');
  });

  it('states plainly when nothing changed', () => {
    expect(buildCommitMessage({ changes: 0, sources: 6, date: '2026-08-18' }))
      .toBe('data: no changes, 6 sources, 2026-08-18');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/publish.test.ts`
Expected: FAIL — `buildCommitMessage` is not exported.

- [ ] **Step 3: Append to `src/workflow/export.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface CommitFacts { changes: number; sources: number; date: string }

/** Spec 14.1: a fixed format so `git log` reads as a changelog of the market. */
export function buildCommitMessage(facts: CommitFacts): string {
  const changes = facts.changes === 0
    ? 'no changes'
    : `${facts.changes} change${facts.changes === 1 ? '' : 's'}`;
  const sources = `${facts.sources} source${facts.sources === 1 ? '' : 's'}`;
  return `data: ${changes}, ${sources}, ${facts.date}`;
}

export interface PublishDeps {
  exec?: (file: string, args: string[], opts: { cwd: string }) => Promise<unknown>;
}

/**
 * Spec 14.1: never force-pushes. A conflicting push aborts and retries next
 * run, because a stale publish is recoverable and a clobbered one is not.
 */
export async function publish(
  repoRoot: string,
  message: string,
  deps: PublishDeps = {}
): Promise<{ pushed: boolean; detail: string }> {
  const exec = deps.exec ?? ((f: string, a: string[], o: { cwd: string }) => run(f, a, o));

  await exec('git', ['add', 'web/public/data'], { cwd: repoRoot });

  try {
    await exec('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot });
    return { pushed: false, detail: 'nothing to publish — the data is unchanged' };
  } catch {
    // A non-zero exit from --quiet means there are staged changes. Proceed.
  }

  await exec('git', ['commit', '-m', message], { cwd: repoRoot });

  try {
    await exec('git', ['push', 'origin', 'HEAD'], { cwd: repoRoot });
    return { pushed: true, detail: message };
  } catch (err) {
    return {
      pushed: false,
      detail: `push rejected, will retry next run: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/publish.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add `--publish` to the export command in `src/cli.ts`**

Replace the `export` command block with:

```ts
program
  .command('export')
  .description('rebuild the published JSON from current database state')
  .option('--publish', 'commit and push the result so Vercel rebuilds')
  .action(async (options: { publish?: boolean }) => {
    const { exportData, publish, buildCommitMessage } = await import('./workflow/export.js');
    const db = openDb(dbPath());
    const outDir = resolve(process.env.BELLWETHER_EXPORT_DIR ?? './web/public/data');
    const stats = exportData(db, outDir);
    console.log(
      `Wrote ${stats.files.join(', ')} to ${outDir} — ` +
      `${stats.competitors} competitors, ${stats.healthySources}/${stats.totalSources} sources healthy.`
    );

    if (options.publish) {
      const changes = db.prepare(
        "SELECT COUNT(*) AS n FROM changes WHERE state = 'confirmed'"
      ).get() as { n: number };
      const message = buildCommitMessage({
        changes: changes.n,
        sources: stats.totalSources,
        date: new Date().toISOString().slice(0, 10),
      });
      const result = await publish(ROOT, message);
      console.log(result.pushed ? `Published: ${result.detail}` : result.detail);
    }

    db.close();
  });
```

- [ ] **Step 6: Create the GitHub repository and push**

```bash
gh repo create bellwether --public --source=. --remote=origin --push
```

- [ ] **Step 7: Connect Vercel**

In the Vercel dashboard: **Add New Project** → import the `bellwether` repo → set **Root Directory** to `web` → deploy. Framework detection should say Next.js; leave build and output settings at their defaults.

Then **Settings → Domains** → add `bellwether.cmxlogic.com`, and add the CNAME record Vercel shows you to the `cmxlogic.com` DNS zone.

- [ ] **Step 8: Publish the first real dataset**

```bash
pnpm bw collect && pnpm bw export --publish
```
Expected: a commit like `data: no changes, 6 sources, 2026-08-18`, a push, a Vercel rebuild, and the board live at `https://bellwether.cmxlogic.com` showing six verified sources.

- [ ] **Step 9: Write `README.md`**

```markdown
# Bellwether

The open archive of developer-infrastructure pricing.

Bellwether checks a set of public pricing pages daily, detects changes that
actually matter, and publishes a free, citable record of how software pricing
moves. It runs on a homelab for well under a dollar a month — against
$15,000+/year for enterprise competitive-intelligence tools.

**Live:** https://bellwether.cmxlogic.com

## How it works

    collect -> extract -> detect -> export        (daily)
                              \-> synthesize      (adaptive)

The raw HTML archive never leaves the homelab. Only extracted facts and
original analysis are published, committed to git so every historical state of
the dataset is retrievable.

Cost is controlled by a layered filter that spends nothing until something
actually changed:

| Gate | Cost | Removes |
|---|---|---|
| Raw hash | $0 | ~80% of runs |
| Normalized hash | $0 | most of the remainder |
| Extraction cache | $0 | repeat page states |
| Structured extract | ~$0.009 | — |
| Object diff | $0 | copy tweaks entirely |
| Materiality score | $0 | feature-list churn |
| Two-observation confirmation | $0 | extractor phantoms |

Collection frequency does not drive cost: 365 daily fetches producing three
real changes cost the same as three fetches.

## Setup

See `docs/superpowers/specs/2026-08-18-bellwether-design.md` section 22, or:

    cp .env.example .env     # fill in the documented values
    docker compose run --rm bellwether doctor
    docker compose up -d

`doctor` checks every prerequisite and tells you what to fix. Run it until it
is green.

## Status

M1 complete: collection, storage, guarded publishing, live board.
M2 next: structured extraction and change detection.

## Data licence

The published dataset is CC BY 4.0. See the `/data` page for the schema,
methodology, and citation block.
```

- [ ] **Step 10: Commit**

```bash
git add README.md src/workflow/export.ts src/cli.ts tests/publish.test.ts
git commit -m "feat: publish to git and document the project"
git push origin HEAD
```

- [ ] **Step 11: Final verification**

```bash
pnpm typecheck && pnpm test
pnpm bw doctor
```
Expected: all tests pass; doctor green except the three `--` pending checks; `https://bellwether.cmxlogic.com` shows six verified sources.

---

## M1 Definition of Done

- [ ] `pnpm test` passes — 5 test files, roughly 60 assertions
- [ ] `pnpm bw doctor` exits 0 with only M2/M5 checks pending
- [ ] `docker compose up -d` runs; the container reports `healthy` after a collect
- [ ] `https://bellwether.cmxlogic.com` renders the board with six verified sources
- [ ] The site is readable in light and dark mode, at 375px wide, and at 200% zoom
- [ ] A second `bellwether collect` inside 24h fetches nothing (cadence honoured)
- [ ] Deleting `web/public/data/board.json` and re-exporting succeeds; emptying the
      `competitors` table and re-exporting is refused by the guard

## Not in M1

Extraction, normalization, slicing, diffing, materiality, confirmation, backfill,
synthesis, charts, the dataset page, the distribution layer, cron, Telegram alerts,
and B2 backup. Those are M2 through M5 in spec section 18.

---

## Spec Coverage

Every spec requirement that falls inside M1, and the task that implements it.

| Spec | Requirement | Task |
|---|---|---|
| 6 | Node 24, TypeScript, pnpm, better-sqlite3 WAL, Zod, Vitest | 1, 2 |
| 6 | Compose healthcheck on `runs` freshness | 10 |
| 7 | Full schema, all nine tables | 2 |
| 7 | `schema_migrations`, immutable migrations | 2 |
| 7.2 | `raw_content` written only on a new hash | 5 |
| 9 gate 1 | Raw hash gate | 5 |
| 11 | Identifying UA with contact URL | 1 |
| 11 | robots.txt fetched, cached 24h, honored | 4 |
| 11 | 10s per-host spacing, jittered | 4 |
| 11 | 3 retries with exponential backoff | 4 |
| 11 | Failed fetch writes `ok=0`, never overwrites good data | 5 |
| 11 | Body cap 5 MB | 4 |
| 11 | Canary asserted post-fetch | 5 |
| 11.1 | The six verified sources | 3 |
| 12.1 | Docker Compose runs one service | 10 |
| 14.1 | Export mechanics, fixed commit format, never force-push | 6, 11 |
| 14.1 | `bellwether.cmxlogic.com` via CNAME to Vercel | 11 |
| 14.3 | Ledger direction, type roles, tabular numerals | 8 |
| 14.3 | Status never colour-alone | 9 |
| 14.3 | Copy rules on empty and failure states | 9 |
| 14.3 | Quality floor: responsive, focus, reduced motion, semantic table | 8, 9 |
| 15.4 | Every run writes a `runs` row | 5 |
| 15.5 | Single-writer lock, 6h stale window | 5 |
| 15.6 | Degraded has a defined exit | 5 |
| 15.7 | Export guards: parse, competitor count, 50% shrink | 6 |
| 17 | CI runs with `LLM_ENABLED=false` | 1 |
| 22.1 | Prerequisites documented in `.env.example` | 1 |
| 22.2 | Quickstart | 10, 11 |
| 22.3 | `doctor` checks 1, 2, 4, 5; 3/6/7 marked pending | 7 |

Deliberately out of scope for M1 and carried to their own milestones: spec 8
(schemas), 9 gates 2–8, 9.1–9.2 (normalize, slice, token guard), 10
(materiality), 12.1 backfill, 12.2–12.6 (detection, tier identity, currency,
confirmation, grounding), 13 (analysis), 14.2 views beyond the board, 14.4
(distribution), 14.5 (dataset), 15.1–15.3 (kill switch, ceiling, heartbeat),
7.3 (backup).

## Self-Review Record

Five defects were found and fixed in this plan before it was committed:

1. **`require` in an ESM test file** — `tests/migrate.test.ts` called
   `require('node:fs')`, which is not defined under `"type": "module"`. Now a
   top-level import.
2. **Cadence comparison was wrong in SQL** — snapshots store ISO 8601
   (`2026-08-18T12:00:00.000Z`) while SQLite's `datetime()` emits
   `2026-08-18 12:00:00`. Comparing them as raw strings lets `'T' > ' '` decide
   same-day ties, so a source would have looked freshly fetched forever and
   never come due again. Both sides now go through `datetime()`.
3. **Staged `.tmp` files leaked on a tripped export guard** — now removed in a
   `catch` so a failure leaves no trace.
4. **`DoctorDeps.migrationsDir` was declared and never read** — removed from the
   interface, the tests, and the CLI.
5. **Tailwind v4 `@theme` cannot nest inside `@media`** — the dark palette would
   have been silently dropped. Dark mode now overrides the emitted custom
   properties on `:root`.
