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
