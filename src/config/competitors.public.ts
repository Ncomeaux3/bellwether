import type { CompetitorConfig } from './types.js';

/**
 * The original six sources verified by hand on 2026-08-18 as server-rendered
 * with prices and tier names present in raw HTML (spec 11.1), plus 21 more
 * admitted on 2026-08-20 by `bellwether qualify` (M3.5) — each having
 * survived two independent live extractions that agreed on a plausible
 * priced-tier count. Full screening record, including the candidates that
 * failed or were rejected: .superpowers/sdd/2026-08-20-bellwether-m35/verdicts.csv
 *
 * Canary strings for the qualification-admitted group are per-site, each
 * proposed by `bellwether qualify` as a tier heading containing no digit —
 * prices change legitimately, a redesign does not. The original six keep
 * the conservative 'Enterprise' canary chosen for M1; they were not in the
 * qualify candidate pool, so no upgrade is proposed for them yet.
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

  // --- Qualification-admitted, 2026-08-20 (`bellwether qualify`) ----------

  // Auth
  {
    slug: 'auth0',
    name: 'Auth0',
    homepage: 'https://auth0.com',
    sources: [{ kind: 'pricing', url: 'https://auth0.com/pricing', canaryString: 'Professional', cadenceHours: 24 }],
  },
  {
    slug: 'clerk',
    name: 'Clerk',
    homepage: 'https://clerk.com',
    sources: [{ kind: 'pricing', url: 'https://clerk.com/pricing', canaryString: 'BusinessMonthlyAnnual', cadenceHours: 24 }],
  },

  // CI & build
  {
    slug: 'buildkite',
    name: 'Buildkite',
    homepage: 'https://buildkite.com',
    sources: [{ kind: 'pricing', url: 'https://buildkite.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'depot',
    name: 'Depot',
    homepage: 'https://depot.dev',
    sources: [{ kind: 'pricing', url: 'https://depot.dev/pricing', canaryString: 'Developer', cadenceHours: 24 }],
  },
  {
    slug: 'github',
    name: 'GitHub',
    homepage: 'https://github.com',
    sources: [{ kind: 'pricing', url: 'https://github.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'gitlab',
    name: 'GitLab',
    homepage: 'https://about.gitlab.com',
    sources: [{ kind: 'pricing', url: 'https://about.gitlab.com/pricing/', canaryString: 'Ons', cadenceHours: 24 }],
  },

  // Data tooling
  {
    slug: 'hasura',
    name: 'Hasura',
    homepage: 'https://hasura.io',
    sources: [{ kind: 'pricing', url: 'https://hasura.io/pricing', canaryString: 'FreeAlways', cadenceHours: 24 }],
  },

  // Databases
  {
    slug: 'planetscale',
    name: 'PlanetScale',
    homepage: 'https://planetscale.com',
    sources: [{ kind: 'pricing', url: 'https://planetscale.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'redis-cloud',
    name: 'Redis Cloud',
    homepage: 'https://redis.io',
    sources: [{ kind: 'pricing', url: 'https://redis.io/pricing/', canaryString: 'EssentialsFrom', cadenceHours: 24 }],
  },
  {
    slug: 'turso',
    name: 'Turso',
    homepage: 'https://turso.tech',
    sources: [{ kind: 'pricing', url: 'https://turso.tech/pricing', canaryString: 'DeveloperScaler', cadenceHours: 24 }],
  },
  {
    slug: 'upstash',
    name: 'Upstash',
    homepage: 'https://upstash.com',
    sources: [{ kind: 'pricing', url: 'https://upstash.com/pricing', canaryString: 'WorkflowSearchBoxFree', cadenceHours: 24 }],
  },

  // Email
  {
    slug: 'postmark',
    name: 'Postmark',
    homepage: 'https://postmarkapp.com',
    sources: [{ kind: 'pricing', url: 'https://postmarkapp.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'resend',
    name: 'Resend',
    homepage: 'https://resend.com',
    sources: [{ kind: 'pricing', url: 'https://resend.com/pricing', canaryString: 'ScaleRecommended', cadenceHours: 24 }],
  },

  // Feature flags
  {
    slug: 'statsig',
    name: 'Statsig',
    homepage: 'https://statsig.com',
    sources: [{ kind: 'pricing', url: 'https://statsig.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },

  // Hosting
  {
    slug: 'fly-io',
    name: 'Fly.io',
    homepage: 'https://fly.io',
    sources: [{ kind: 'pricing', url: 'https://fly.io/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'netlify',
    name: 'Netlify',
    homepage: 'https://www.netlify.com',
    sources: [{ kind: 'pricing', url: 'https://www.netlify.com/pricing/', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'render',
    name: 'Render',
    homepage: 'https://render.com',
    sources: [{ kind: 'pricing', url: 'https://render.com/pricing', canaryString: 'PricingWorkflowsFrom', cadenceHours: 24 }],
  },
  {
    slug: 'vercel',
    name: 'Vercel',
    homepage: 'https://vercel.com',
    sources: [{ kind: 'pricing', url: 'https://vercel.com/pricing', canaryString: 'AgentBeta', cadenceHours: 24 }],
  },

  // Observability
  {
    slug: 'honeycomb',
    name: 'Honeycomb',
    homepage: 'https://www.honeycomb.io',
    sources: [{ kind: 'pricing', url: 'https://www.honeycomb.io/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },
  {
    slug: 'new-relic',
    name: 'New Relic',
    homepage: 'https://newrelic.com',
    sources: [{ kind: 'pricing', url: 'https://newrelic.com/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  },

  // Vector stores
  {
    slug: 'pinecone',
    name: 'Pinecone',
    homepage: 'https://www.pinecone.io',
    sources: [{ kind: 'pricing', url: 'https://www.pinecone.io/pricing/', canaryString: 'TokensUnlimited', cadenceHours: 24 }],
  },
];
