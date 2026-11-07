import { describe, expect, it } from 'vitest';
import { formatDay, readableText } from '../src/lib/format.js';

/** Explanatory copy as people read it (D-047): no raw ISO timestamps, user ids or UUIDs. */
describe('readable explanatory text', () => {
  it('shows timestamps as local date and time', () => {
    const out = readableText('daily cycle limit (1) reached; next cycle 2026-11-07T11:25:07.533Z');
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(out).toMatch(/^daily cycle limit \(1\) reached; next cycle \S/);
    expect(out).toContain(new Date('2026-11-07T11:25:07.533Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  });

  it('names actors instead of showing their identifiers', () => {
    expect(readableText('paused by user:eOuvEUZpCsvMlc6FxexxVpgWbU4MMukt')).toBe('paused by a team member');
    expect(readableText('paused by user:eOuvEUZpCsvMlc6FxexxVpgWbU4MMukt', { userId: 'eOuvEUZpCsvMlc6FxexxVpgWbU4MMukt' })).toBe('paused by you');
    expect(readableText('discarded by system:autopilot')).toBe('discarded by the Autopilot');
    expect(readableText('cancelled by system:something-else')).toBe('cancelled by the system');
  });

  it('leaves technical UUIDs out of the sentence', () => {
    expect(readableText('the Page already has a post today (940be643-85ab-423f-b4d7-751d6a0d45c5); one post a day')).toBe('the Page already has a post today; one post a day');
    expect(readableText('Studio card for plan item 45daaf53-0c04-4a48-9bb1-3d2ac2da3c00.')).toBe('Studio card for plan item.');
    expect(readableText('Superseded: the same lesson was published on 2026-11-06.')).toBe('Superseded: the same lesson was published on 2026-11-06.');
  });

  it('formats a reported calendar day without shifting it by time zone', () => {
    expect(formatDay('2026-11-02')).toBe(new Date('2026-11-02T00:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }));
    expect(formatDay('2026-11-02')).toMatch(/2/);
    expect(formatDay('not a day')).toBe('not a day');
  });
});
