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
