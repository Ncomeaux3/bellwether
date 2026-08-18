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
