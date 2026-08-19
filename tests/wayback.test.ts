import { describe, expect, it } from 'vitest';
import {
  captureUrl, cdxQueryUrl, parseCdxResponse, waybackTimestampToIso, WAYBACK_HOST,
} from '../src/tools/wayback.js';

describe('cdxQueryUrl', () => {
  it('asks for one capture per month, 200s only, with the fields we parse', () => {
    const url = new URL(cdxQueryUrl('https://linear.app/pricing', { from: '20250101', to: '20260818' }));
    expect(url.host).toBe(WAYBACK_HOST);
    expect(url.pathname).toBe('/cdx/search/cdx');
    expect(url.searchParams.get('url')).toBe('https://linear.app/pricing');
    expect(url.searchParams.get('output')).toBe('json');
    expect(url.searchParams.get('collapse')).toBe('timestamp:6');
    expect(url.searchParams.get('filter')).toBe('statuscode:200');
    expect(url.searchParams.get('from')).toBe('20250101');
    expect(url.searchParams.get('to')).toBe('20260818');
    expect(url.searchParams.get('fl')).toBe('timestamp,original,statuscode,digest');
  });

  it('never collapses on digest — that would delete the confirmation signal (R2)', () => {
    const url = new URL(cdxQueryUrl('https://x.test/p', { from: '20250101', to: '20260101' }));
    expect(url.searchParams.getAll('collapse')).toEqual(['timestamp:6']);
  });
});

describe('parseCdxResponse', () => {
  const BODY = JSON.stringify([
    ['timestamp', 'original', 'statuscode', 'digest'],
    ['20250116002909', 'https://linear.app/pricing', '200', 'AAA'],
    ['20250209133622', 'https://linear.app/pricing', '200', 'BBB'],
  ]);

  it('drops the header row', () => {
    const captures = parseCdxResponse(BODY);
    expect(captures).toHaveLength(2);
    expect(captures[0]).toEqual({
      timestamp: '20250116002909',
      original: 'https://linear.app/pricing',
      statusCode: '200',
      digest: 'AAA',
    });
  });

  it('treats an empty body as no captures, not an error', () => {
    expect(parseCdxResponse('')).toEqual([]);
    expect(parseCdxResponse('   \n')).toEqual([]);
  });

  it('returns nothing for a body that is not JSON rather than throwing', () => {
    expect(parseCdxResponse('<html>502 Bad Gateway</html>')).toEqual([]);
  });

  it('skips rows that are short, mistyped, or carry a bad timestamp', () => {
    const body = JSON.stringify([
      ['timestamp', 'original', 'statuscode', 'digest'],
      ['20250116002909', 'https://a.test/p', '200', 'AAA'],
      ['2025', 'https://a.test/p', '200', 'SHORT_TS'],
      ['20250209133622', 'https://a.test/p'],
      [20250309133622, 'https://a.test/p', '200', 'NUMERIC'],
      ['20250409133622', 'https://a.test/p', '404', 'NOT_200'],
    ]);
    const captures = parseCdxResponse(body);
    expect(captures.map(c => c.digest)).toEqual(['AAA']);
  });

  it('returns nothing when the payload is not an array of arrays', () => {
    expect(parseCdxResponse('{"error":"blocked"}')).toEqual([]);
    expect(parseCdxResponse('[]')).toEqual([]);
  });
});

describe('waybackTimestampToIso', () => {
  it('converts a 14-digit capture stamp to UTC ISO 8601', () => {
    expect(waybackTimestampToIso('20250116002909')).toBe('2025-01-16T00:29:09.000Z');
  });

  it('sorts lexically against the ISO stamps live collection writes', () => {
    const historical = waybackTimestampToIso('20250116002909')!;
    const live = '2026-08-19T07:00:00.000Z';
    expect(historical < live).toBe(true);
  });

  it('rejects anything that is not 14 digits', () => {
    expect(waybackTimestampToIso('2025')).toBeNull();
    expect(waybackTimestampToIso('2025011600290x')).toBeNull();
    expect(waybackTimestampToIso('202501160029099')).toBeNull();
  });

  it('rejects a stamp whose digits are not a real calendar instant', () => {
    expect(waybackTimestampToIso('20250132002909')).toBeNull();  // 32 January
    expect(waybackTimestampToIso('20251316002909')).toBeNull();  // month 13
    expect(waybackTimestampToIso('20250116256109')).toBeNull();  // hour 25
  });
});

describe('captureUrl', () => {
  it('inserts the id_ suffix so the Archive returns original bytes', () => {
    expect(captureUrl('20250116002909', 'https://linear.app/pricing'))
      .toBe('https://web.archive.org/web/20250116002909id_/https://linear.app/pricing');
  });
});
