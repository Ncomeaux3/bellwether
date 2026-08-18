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
