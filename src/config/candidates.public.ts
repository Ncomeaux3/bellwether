export interface CandidateConfig {
  name: string;
  category: string;
  url: string;
}

/**
 * Spec 11.1: the M3.5 candidate pool for `bellwether qualify`, transcribed
 * from the design spec's list verbatim (§11.1, lines 503-510). Vercel is
 * included deliberately — the spec calls it "a known qualification failure
 * and a useful test case" (24 KB shell, pricing hydrated client-side), so it
 * belongs here as a live check that the screen actually rejects something.
 */
export const CANDIDATES: CandidateConfig[] = [
  // Hosting
  { name: 'Netlify', category: 'hosting', url: 'https://www.netlify.com/pricing/' },
  { name: 'Railway', category: 'hosting', url: 'https://railway.com/pricing' },
  { name: 'Render', category: 'hosting', url: 'https://render.com/pricing' },
  { name: 'Fly.io', category: 'hosting', url: 'https://fly.io/pricing' },
  { name: 'Heroku', category: 'hosting', url: 'https://www.heroku.com/pricing' },
  { name: 'Vercel', category: 'hosting', url: 'https://vercel.com/pricing' },

  // Databases
  { name: 'Neon', category: 'databases', url: 'https://neon.tech/pricing' },
  { name: 'PlanetScale', category: 'databases', url: 'https://planetscale.com/pricing' },
  { name: 'Turso', category: 'databases', url: 'https://turso.tech/pricing' },
  { name: 'Upstash', category: 'databases', url: 'https://upstash.com/pricing' },
  { name: 'MongoDB Atlas', category: 'databases', url: 'https://www.mongodb.com/pricing' },
  { name: 'Redis Cloud', category: 'databases', url: 'https://redis.io/pricing/' },
  { name: 'Convex', category: 'databases', url: 'https://www.convex.dev/pricing' },
  { name: 'Xata', category: 'databases', url: 'https://xata.io/pricing' },

  // Auth
  { name: 'Clerk', category: 'auth', url: 'https://clerk.com/pricing' },
  { name: 'Auth0', category: 'auth', url: 'https://auth0.com/pricing' },
  { name: 'WorkOS', category: 'auth', url: 'https://workos.com/pricing' },
  { name: 'Stytch', category: 'auth', url: 'https://stytch.com/pricing' },

  // Email
  { name: 'Resend', category: 'email', url: 'https://resend.com/pricing' },
  { name: 'Postmark', category: 'email', url: 'https://postmarkapp.com/pricing' },
  { name: 'SendGrid', category: 'email', url: 'https://sendgrid.com/en-us/pricing' },
  { name: 'Loops', category: 'email', url: 'https://loops.so/pricing' },

  // Observability
  { name: 'Datadog', category: 'observability', url: 'https://www.datadoghq.com/pricing/' },
  { name: 'New Relic', category: 'observability', url: 'https://newrelic.com/pricing' },
  { name: 'Honeycomb', category: 'observability', url: 'https://www.honeycomb.io/pricing' },
  { name: 'Grafana Cloud', category: 'observability', url: 'https://grafana.com/pricing/' },
  { name: 'Better Stack', category: 'observability', url: 'https://betterstack.com/pricing' },
  { name: 'PostHog', category: 'observability', url: 'https://posthog.com/pricing' },

  // CI and build
  { name: 'CircleCI', category: 'ci-and-build', url: 'https://circleci.com/pricing/' },
  { name: 'Buildkite', category: 'ci-and-build', url: 'https://buildkite.com/pricing' },
  { name: 'Depot', category: 'ci-and-build', url: 'https://depot.dev/pricing' },
  { name: 'GitHub', category: 'ci-and-build', url: 'https://github.com/pricing' },
  { name: 'GitLab', category: 'ci-and-build', url: 'https://about.gitlab.com/pricing/' },

  // Edge and CDN
  { name: 'Cloudflare', category: 'edge-and-cdn', url: 'https://www.cloudflare.com/plans/' },
  { name: 'Fastly', category: 'edge-and-cdn', url: 'https://www.fastly.com/pricing' },
  { name: 'Bunny', category: 'edge-and-cdn', url: 'https://bunny.net/pricing/' },

  // Search
  { name: 'Algolia', category: 'search', url: 'https://www.algolia.com/pricing/' },
  { name: 'Meilisearch', category: 'search', url: 'https://www.meilisearch.com/pricing' },
  { name: 'Typesense', category: 'search', url: 'https://typesense.org/pricing/' },

  // Vector stores
  { name: 'Pinecone', category: 'vector-stores', url: 'https://www.pinecone.io/pricing/' },
  { name: 'Weaviate', category: 'vector-stores', url: 'https://weaviate.io/pricing' },
  { name: 'Qdrant', category: 'vector-stores', url: 'https://qdrant.tech/pricing/' },

  // Payments infrastructure
  { name: 'Stripe', category: 'payments', url: 'https://stripe.com/pricing' },
  { name: 'Paddle', category: 'payments', url: 'https://www.paddle.com/pricing' },
  { name: 'Lemon Squeezy', category: 'payments', url: 'https://www.lemonsqueezy.com/pricing' },

  // Feature flags
  { name: 'LaunchDarkly', category: 'feature-flags', url: 'https://launchdarkly.com/pricing/' },
  { name: 'Statsig', category: 'feature-flags', url: 'https://statsig.com/pricing' },

  // Secrets
  { name: 'Doppler', category: 'secrets', url: 'https://www.doppler.com/pricing' },
  { name: 'Infisical', category: 'secrets', url: 'https://infisical.com/pricing' },

  // Data tooling
  { name: 'Prisma', category: 'data-tooling', url: 'https://www.prisma.io/pricing' },
  { name: 'Hasura', category: 'data-tooling', url: 'https://hasura.io/pricing' },
];
