export const WAYBACK_HOST = 'web.archive.org';

/** One row of a CDX response, after the header row is dropped. */
export interface Capture {
  timestamp: string;
  original: string;
  statusCode: string;
  digest: string;
}

/**
 * Spec 12.1. `collapse=timestamp:6` yields one capture per calendar month.
 *
 * Deliberately NOT collapsed on `digest`: confirmation (spec 12.5) promotes a
 * change only when its new value is observed a second time, and a second
 * observation of an unchanged page IS a repeated digest. Collapsing them here
 * would delete the exact evidence confirmation consumes, leaving every
 * backfilled change stuck in `candidate` forever.
 */
export function cdxQueryUrl(targetUrl: string, opts: { from: string; to: string }): string {
  const url = new URL(`https://${WAYBACK_HOST}/cdx/search/cdx`);
  url.searchParams.set('url', targetUrl);
  url.searchParams.set('output', 'json');
  url.searchParams.set('collapse', 'timestamp:6');
  url.searchParams.set('filter', 'statuscode:200');
  url.searchParams.set('from', opts.from);
  url.searchParams.set('to', opts.to);
  url.searchParams.set('fl', 'timestamp,original,statuscode,digest');
  return url.toString();
}

/**
 * Never throws. A CDX outage answers with an HTML error page or an empty body,
 * and neither is worth failing a multi-hour resumable backfill over — the
 * caller records "no captures found" and the next run retries.
 */
export function parseCdxResponse(body: string): Capture[] {
  if (body.trim() === '') return [];       // the API's genuine "no matches" answer

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const captures: Capture[] = [];
  for (const row of payload.slice(1)) {    // row 0 is the header
    if (!Array.isArray(row) || row.length < 4) continue;
    const [timestamp, original, statusCode, digest] = row;
    if (typeof timestamp !== 'string' || typeof original !== 'string') continue;
    if (typeof statusCode !== 'string' || typeof digest !== 'string') continue;
    if (statusCode !== '200') continue;    // belt and braces; the filter already asks for this
    if (waybackTimestampToIso(timestamp) === null) continue;
    captures.push({ timestamp, original, statusCode, digest });
  }
  return captures;
}

/**
 * `20250116002909` -> `2025-01-16T00:29:09.000Z`.
 *
 * This value becomes `snapshots.observed_at`, which detect (spec 12.2) orders
 * by and confirm compares as a string, so it must be the same ISO shape live
 * collection writes. Returns null rather than an Invalid Date for anything
 * malformed: an unparseable stamp must skip the capture, never date it to the
 * epoch or to today.
 */
export function waybackTimestampToIso(ts: string): string | null {
  if (!/^\d{14}$/.test(ts)) return null;

  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(4, 6));
  const day = Number(ts.slice(6, 8));
  const hour = Number(ts.slice(8, 10));
  const minute = Number(ts.slice(10, 12));
  const second = Number(ts.slice(12, 14));

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Date.UTC silently rolls 32 January into 1 February. Round-tripping the
  // components back out is what actually rejects a nonsense stamp.
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
  ) return null;

  return date.toISOString();
}

/**
 * The `id_` suffix asks the Archive for the original stored bytes. Without it
 * the response carries an injected Archive toolbar, which changes the DOM,
 * changes every normalized hash, and makes historical snapshots incomparable
 * with live ones.
 */
export function captureUrl(timestamp: string, targetUrl: string): string {
  return `https://${WAYBACK_HOST}/web/${timestamp}id_/${targetUrl}`;
}
