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
