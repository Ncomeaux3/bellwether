import type { Metadata } from 'next';
import { Bricolage_Grotesque, IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import './globals.css';

const bricolage = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });
const publicSans = Public_Sans({ subsets: ['latin'], variable: '--font-public-sans', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://bellwether-nicholas-projects-cdfeb046.vercel.app'),
  title: 'Bellwether — the open archive of developer-infrastructure pricing',
  description:
    'Every pricing change across developer infrastructure, recorded daily, confirmed before publishing, and free to cite.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${publicSans.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-surface text-ink antialiased">
        {/* React 19 hoists <link> into <head> regardless of where it renders. */}
        <link rel="alternate" type="application/rss+xml" title="Bellwether changes" href="/changes.xml" />
        <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-16">
          {children}
          <footer className="mt-20 border-t border-rule pt-6 text-sm text-ink-muted">
            <p>
              Bellwether records public pricing pages. The raw archive stays private; only
              derived data is published, never the pages themselves.
            </p>
            <p className="mt-2">
              <a href="/data/" className="text-ink-secondary underline decoration-rule-strong underline-offset-4 hover:text-ink">
                The dataset
              </a>
              {' · '}
              <a href="/changes.xml" className="text-ink-secondary underline decoration-rule-strong underline-offset-4 hover:text-ink">
                RSS feed
              </a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
