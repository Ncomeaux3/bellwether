import { describe, expect, it } from 'vitest';
import { USER_AGENT } from '../src/version.js';

describe('USER_AGENT', () => {
  it('identifies the project and carries a contact URL', () => {
    expect(USER_AGENT).toContain('Bellwether');
    expect(USER_AGENT).toContain('https://bellwether.cmxlogic.com/about');
  });

  it('is a single line', () => {
    expect(USER_AGENT).not.toContain('\n');
  });
});
