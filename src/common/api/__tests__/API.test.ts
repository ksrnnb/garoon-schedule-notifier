import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScheduleEventsRangeEnd,
  buildScheduleEventsRangeStart,
} from '../API';

// Date#getTimezoneOffset returns minutes-from-UTC with the sign reversed:
// JST(-540), UTC(0), PST(+480), IST(-330).
const mockTzOffset = (mins: number) => {
  vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(mins);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildScheduleEventsRangeStart', () => {
  it('returns yesterday 23:59:59 local-time (JST)', () => {
    mockTzOffset(-540);
    const today = new Date(2026, 3, 25, 12, 30, 45); // April 25, 2026 (local)
    expect(buildScheduleEventsRangeStart(today)).toBe(
      '2026-04-24T23:59:59+09:00',
    );
  });

  it('rolls back to previous month on the 1st', () => {
    mockTzOffset(-540);
    const today = new Date(2026, 3, 1); // April 1 → March 31
    expect(buildScheduleEventsRangeStart(today)).toBe(
      '2026-03-31T23:59:59+09:00',
    );
  });

  it('rolls back to previous year on January 1st', () => {
    mockTzOffset(-540);
    const today = new Date(2026, 0, 1);
    expect(buildScheduleEventsRangeStart(today)).toBe(
      '2025-12-31T23:59:59+09:00',
    );
  });

  it('zero-pads single-digit month and day', () => {
    mockTzOffset(-540);
    const today = new Date(2026, 2, 9); // March 9 → March 8
    expect(buildScheduleEventsRangeStart(today)).toBe(
      '2026-03-08T23:59:59+09:00',
    );
  });

  it('emits a negative offset for west-of-UTC zones (PST)', () => {
    mockTzOffset(480);
    const today = new Date(2026, 3, 25);
    expect(buildScheduleEventsRangeStart(today)).toBe(
      '2026-04-24T23:59:59-08:00',
    );
  });

  it('renders sub-hour offsets (India Standard Time, UTC+5:30)', () => {
    mockTzOffset(-330);
    const today = new Date(2026, 3, 25);
    expect(buildScheduleEventsRangeStart(today)).toBe(
      '2026-04-24T23:59:59+05:30',
    );
  });

  it('emits "+00:00" for UTC', () => {
    mockTzOffset(0);
    const today = new Date(2026, 3, 25);
    expect(buildScheduleEventsRangeStart(today)).toBe(
      '2026-04-24T23:59:59+00:00',
    );
  });

  it('uses today (now) by default when no argument is provided', () => {
    mockTzOffset(-540);
    expect(buildScheduleEventsRangeStart()).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });
});

describe('buildScheduleEventsRangeEnd', () => {
  it('returns 7 days from today at 23:59:59 local-time (JST)', () => {
    mockTzOffset(-540);
    const today = new Date(2026, 3, 25, 12, 30, 45); // April 25 + 7 = May 2
    expect(buildScheduleEventsRangeEnd(today)).toBe(
      '2026-05-02T23:59:59+09:00',
    );
  });

  it('rolls forward into the next month', () => {
    mockTzOffset(-540);
    const today = new Date(2026, 2, 28); // March 28 + 7 = April 4
    expect(buildScheduleEventsRangeEnd(today)).toBe(
      '2026-04-04T23:59:59+09:00',
    );
  });

  it('rolls forward into the next year', () => {
    mockTzOffset(-540);
    const today = new Date(2025, 11, 28); // December 28 + 7 = January 4 next year
    expect(buildScheduleEventsRangeEnd(today)).toBe(
      '2026-01-04T23:59:59+09:00',
    );
  });

  it('zero-pads single-digit month and day', () => {
    mockTzOffset(-540);
    const today = new Date(2026, 0, 1); // January 1 + 7 = January 8
    expect(buildScheduleEventsRangeEnd(today)).toBe(
      '2026-01-08T23:59:59+09:00',
    );
  });

  it('emits a negative offset for west-of-UTC zones (PST)', () => {
    mockTzOffset(480);
    const today = new Date(2026, 3, 25);
    expect(buildScheduleEventsRangeEnd(today)).toBe(
      '2026-05-02T23:59:59-08:00',
    );
  });

  it('uses today (now) by default when no argument is provided', () => {
    mockTzOffset(-540);
    expect(buildScheduleEventsRangeEnd()).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });
});
