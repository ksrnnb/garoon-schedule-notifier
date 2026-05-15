import { describe, expect, it } from 'vitest';
import { WAKE_THRESHOLD_MS, detectWake } from '../sleep';

const NOW = new Date(2026, 3, 25, 12, 0, 0).getTime();

describe('detectWake', () => {
  it('returns false when lastAlarmPingedAt is undefined (first run)', () => {
    expect(detectWake(NOW, undefined)).toBe(false);
  });

  it('returns false when the gap is exactly WAKE_THRESHOLD_MS', () => {
    expect(detectWake(NOW, NOW - WAKE_THRESHOLD_MS)).toBe(false);
  });

  it('returns true when the gap is WAKE_THRESHOLD_MS + 1ms', () => {
    expect(detectWake(NOW, NOW - WAKE_THRESHOLD_MS - 1)).toBe(true);
  });

  it('returns true after several hours (Chrome was closed overnight)', () => {
    const sixHoursAgo = NOW - 6 * 60 * 60 * 1000;
    expect(detectWake(NOW, sixHoursAgo)).toBe(true);
  });
});
