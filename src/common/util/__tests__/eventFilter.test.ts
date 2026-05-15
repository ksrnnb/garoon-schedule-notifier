import { describe, expect, it } from 'vitest';
import {
  GRACE_MS,
  PRECISE_LOOKAHEAD_MS,
  filterUpcomingEvents,
  findNextPreciseDeadline,
  mergeAndPruneNotifiedKeys,
  pickEventsToNotify,
} from '../eventFilter';
import { buildEvent } from '../../../../test/fixtures/events';

const DAY_MS = 86_400_000;

// Use local-time component constructor so tests are timezone-independent
// (filterUpcomingEvents derives todayStart via setHours, also local-time).
const NOW_LOCAL = new Date(2026, 3, 25, 12, 0, 0);
const NOW = NOW_LOCAL.getTime();
const TODAY_START = new Date(2026, 3, 25, 0, 0, 0).getTime();

describe('filterUpcomingEvents', () => {
  it('returns an empty array when given no events', () => {
    expect(filterUpcomingEvents([], NOW)).toEqual([]);
  });

  it('drops events that started before local midnight today', () => {
    const yesterday = buildEvent({
      id: 'y',
      start: new Date(2026, 3, 24, 23, 59, 59),
    });
    expect(filterUpcomingEvents([yesterday], NOW)).toEqual([]);
  });

  it('keeps an event whose start equals today 00:00 local (>= boundary)', () => {
    const onMidnight = buildEvent({ id: 'm', start: new Date(TODAY_START) });
    const result = filterUpcomingEvents([onMidnight], NOW);
    expect(result.map(e => e.id)).toEqual(['m']);
  });

  it('keeps an event already finished earlier today (popup needs it)', () => {
    const finished = buildEvent({
      id: 'past-today',
      start: new Date(2026, 3, 25, 9, 0, 0),
    });
    const result = filterUpcomingEvents([finished], NOW);
    expect(result.map(e => e.id)).toEqual(['past-today']);
  });

  it('keeps an event ~1 day from now minus 1ms (strict less-than horizon)', () => {
    const justInside = buildEvent({
      id: 'inside',
      start: new Date(NOW + DAY_MS - 1),
    });
    const result = filterUpcomingEvents([justInside], NOW);
    expect(result.map(e => e.id)).toEqual(['inside']);
  });

  it('drops an event exactly 1 day from now (strict horizon)', () => {
    const onHorizon = buildEvent({
      id: 'edge',
      start: new Date(NOW + DAY_MS),
    });
    expect(filterUpcomingEvents([onHorizon], NOW)).toEqual([]);
  });

  it('drops an event 5 days from now', () => {
    const farFuture = buildEvent({
      id: 'far',
      start: new Date(NOW + 5 * DAY_MS),
    });
    expect(filterUpcomingEvents([farFuture], NOW)).toEqual([]);
  });

  it('honours a custom daysAhead horizon', () => {
    const fiveDaysOut = buildEvent({
      id: '5d',
      start: new Date(NOW + 5 * DAY_MS),
    });
    expect(filterUpcomingEvents([fiveDaysOut], NOW, 3)).toEqual([]);
    expect(filterUpcomingEvents([fiveDaysOut], NOW, 7).map(e => e.id)).toEqual([
      '5d',
    ]);
  });

  it('preserves input order for kept events', () => {
    const a = buildEvent({ id: 'a', start: new Date(2026, 3, 25, 9, 0) });
    const b = buildEvent({ id: 'b', start: new Date(2026, 3, 25, 13, 0) });
    const c = buildEvent({ id: 'c', start: new Date(2026, 3, 26, 10, 0) });
    const yesterday = buildEvent({
      id: 'y',
      start: new Date(2026, 3, 24, 10, 0),
    });
    const result = filterUpcomingEvents([yesterday, a, c, b], NOW);
    expect(result.map(e => e.id)).toEqual(['a', 'c', 'b']);
  });
});

// notifiedKeys 形式: `${id}:${startMs}:${offset}`
const keyOf = (id: string, start: Date, offset: number): string =>
  `${id}:${start.getTime()}:${offset}`;

describe('pickEventsToNotify', () => {
  it('returns [] when events is undefined', () => {
    expect(pickEventsToNotify(undefined, NOW, [10], [])).toEqual([]);
  });

  it('returns [] when offset list is empty', () => {
    const ev = buildEvent({ id: 'x', start: new Date(NOW + 10 * 60_000) });
    expect(pickEventsToNotify([ev], NOW, [], [])).toEqual([]);
  });

  it('matches an event whose start is exactly one offset away (delta == offset*60_000)', () => {
    const start = new Date(NOW + 10 * 60_000);
    const ev = buildEvent({ id: 't10', start });
    const result = pickEventsToNotify([ev], NOW, [10], []);
    expect(result).toEqual([
      { event: ev, offset: 10, key: keyOf('t10', start, 10) },
    ]);
  });

  it('skips when start is 1ms past the offset (delta == offset*60_000 + 1ms)', () => {
    const ev = buildEvent({
      id: 't10b',
      start: new Date(NOW + 10 * 60_000 + 1),
    });
    expect(pickEventsToNotify([ev], NOW, [10], [])).toEqual([]);
  });

  it('rescues an event when delta is 30s past the notify deadline (alarm lag)', () => {
    // start = now + 1min30s, offset=2min → delta(1.5min) <= 2min, key not in notifiedKeys
    const start = new Date(NOW + 90_000);
    const ev = buildEvent({ id: 'lag', start });
    const result = pickEventsToNotify([ev], NOW, [2], []);
    expect(result.map(p => p.event.id)).toEqual(['lag']);
  });

  it('fires for a past event still within GRACE_MS (e.g. just started)', () => {
    const start = new Date(NOW - 30_000);
    const ev = buildEvent({ id: 'just-started', start });
    const result = pickEventsToNotify([ev], NOW, [2], []);
    expect(result.map(p => p.event.id)).toEqual(['just-started']);
  });

  it('fires at exactly -GRACE_MS boundary', () => {
    const start = new Date(NOW - GRACE_MS);
    const ev = buildEvent({ id: 'edge', start });
    const result = pickEventsToNotify([ev], NOW, [2], []);
    expect(result.map(p => p.event.id)).toEqual(['edge']);
  });

  it('skips an event past -GRACE_MS - 1ms', () => {
    const start = new Date(NOW - GRACE_MS - 1);
    const ev = buildEvent({ id: 'too-old', start });
    expect(pickEventsToNotify([ev], NOW, [2], [])).toEqual([]);
  });

  it('skips when the notify key is already in notifiedKeys (dedup)', () => {
    const start = new Date(NOW + 10 * 60_000);
    const ev = buildEvent({ id: 't10', start });
    const notified = [keyOf('t10', start, 10)];
    expect(pickEventsToNotify([ev], NOW, [10], notified)).toEqual([]);
  });

  it('accepts notifiedKeys as a Set', () => {
    const start = new Date(NOW + 10 * 60_000);
    const ev = buildEvent({ id: 't10', start });
    const notified = new Set([keyOf('t10', start, 10)]);
    expect(pickEventsToNotify([ev], NOW, [10], notified)).toEqual([]);
  });

  it('returns only the offset whose deadline has been crossed when multiple offsets are registered', () => {
    // delta = 8min: 10min crossed (8 <= 10), 2min not crossed (8 > 2)
    const start = new Date(NOW + 8 * 60_000);
    const ev = buildEvent({ id: 'multi', start });
    const result = pickEventsToNotify([ev], NOW, [10, 2], []);
    expect(result.map(p => p.offset)).toEqual([10]);
  });

  it('coalesces duplicate offsets (e.g. [10, 10] only fires once)', () => {
    const start = new Date(NOW + 10 * 60_000);
    const ev = buildEvent({ id: 'dup', start });
    const result = pickEventsToNotify([ev], NOW, [10, 10], []);
    expect(result).toHaveLength(1);
  });

  it('distinguishes occurrences with the same id but different start (recurring events)', () => {
    // Both occurrences are within the offset=10 window. The first one is
    // already marked notified, so only the second should fire.
    const start1 = new Date(NOW + 5 * 60_000);
    const start2 = new Date(NOW + 8 * 60_000);
    const occ1 = buildEvent({ id: 'rec', start: start1 });
    const occ2 = buildEvent({ id: 'rec', start: start2 });
    const notified = [keyOf('rec', start1, 10)];
    const result = pickEventsToNotify([occ1, occ2], NOW, [10], notified);
    expect(result.map(p => p.key)).toEqual([keyOf('rec', start2, 10)]);
  });
});

describe('findNextPreciseDeadline', () => {
  it('returns undefined when events is undefined', () => {
    expect(findNextPreciseDeadline(undefined, NOW, [1], [])).toBeUndefined();
  });

  it('returns undefined when notifyMinutesBeforeList is empty', () => {
    const ev = buildEvent({ id: 'x', start: new Date(NOW + 60_000) });
    expect(findNextPreciseDeadline([ev], NOW, [], [])).toBeUndefined();
  });

  it('returns undefined when no deadline falls within the lookahead', () => {
    // event start 30min away, offset 1min → deadline 29min ahead → outside 5min
    const ev = buildEvent({ id: 'far', start: new Date(NOW + 30 * 60_000) });
    expect(findNextPreciseDeadline([ev], NOW, [1], [])).toBeUndefined();
  });

  it('returns the deadline for a short-offset reminder firing soon (offset=1, start in 4min)', () => {
    const start = new Date(NOW + 4 * 60_000);
    const ev = buildEvent({ id: 's', start });
    const result = findNextPreciseDeadline([ev], NOW, [1], []);
    expect(result).toBe(start.getTime() - 1 * 60_000);
  });

  it('returns the deadline for a long-offset reminder (offset=60) when event is 64min away', () => {
    // event start in 64min, offset 60min → deadline in 4min → within lookahead
    // 「event.start 基準」ではなく「deadline 基準」であることの確認
    const start = new Date(NOW + 64 * 60_000);
    const ev = buildEvent({ id: 'long', start });
    const result = findNextPreciseDeadline([ev], NOW, [60], []);
    expect(result).toBe(start.getTime() - 60 * 60_000);
  });

  it('skips deadlines that have already passed', () => {
    // event start in 30s, offset 1min → deadline 30s ago (past)
    const ev = buildEvent({ id: 'past', start: new Date(NOW + 30_000) });
    expect(findNextPreciseDeadline([ev], NOW, [1], [])).toBeUndefined();
  });

  it('skips events that have already started', () => {
    const ev = buildEvent({ id: 'started', start: new Date(NOW - 1_000) });
    expect(findNextPreciseDeadline([ev], NOW, [1], [])).toBeUndefined();
  });

  it('includes a deadline exactly at the lookahead boundary (deadline - now == lookaheadMs)', () => {
    // event start = lookahead + offset, deadline - now == lookaheadMs
    const start = new Date(NOW + PRECISE_LOOKAHEAD_MS + 1 * 60_000);
    const ev = buildEvent({ id: 'edge', start });
    const result = findNextPreciseDeadline([ev], NOW, [1], []);
    expect(result).toBe(NOW + PRECISE_LOOKAHEAD_MS);
  });

  it('excludes a deadline 1ms past the lookahead boundary', () => {
    const start = new Date(NOW + PRECISE_LOOKAHEAD_MS + 1 * 60_000 + 1);
    const ev = buildEvent({ id: 'past-edge', start });
    expect(findNextPreciseDeadline([ev], NOW, [1], [])).toBeUndefined();
  });

  it('skips when the (event, offset) key is already in notifiedKeys', () => {
    const start = new Date(NOW + 2 * 60_000);
    const ev = buildEvent({ id: 'done', start });
    const notified = [`done:${start.getTime()}:1`];
    expect(findNextPreciseDeadline([ev], NOW, [1], notified)).toBeUndefined();
  });

  it('accepts notifiedKeys as a Set', () => {
    const start = new Date(NOW + 2 * 60_000);
    const ev = buildEvent({ id: 'done', start });
    const notified = new Set([`done:${start.getTime()}:1`]);
    expect(findNextPreciseDeadline([ev], NOW, [1], notified)).toBeUndefined();
  });

  it('returns the earliest deadline across multiple candidates', () => {
    // a: offset=1, start in 4min → deadline +3min
    // b: offset=1, start in 2min → deadline +1min  ← earliest
    // c: offset=60, start in 63min → deadline +3min
    const a = buildEvent({ id: 'a', start: new Date(NOW + 4 * 60_000) });
    const b = buildEvent({ id: 'b', start: new Date(NOW + 2 * 60_000) });
    const c = buildEvent({ id: 'c', start: new Date(NOW + 63 * 60_000) });
    const result = findNextPreciseDeadline([a, b, c], NOW, [1, 60], []);
    expect(result).toBe(NOW + 1 * 60_000);
  });

  it('considers all offsets for the same event and picks the earliest deadline', () => {
    // event start in 6min. offsets [1, 5]:
    //   offset=1 → deadline +5min (lookahead boundary, included)
    //   offset=5 → deadline +1min  ← earliest
    const start = new Date(NOW + 6 * 60_000);
    const ev = buildEvent({ id: 'multi', start });
    const result = findNextPreciseDeadline([ev], NOW, [1, 5], []);
    expect(result).toBe(start.getTime() - 5 * 60_000);
  });

  it('honors a custom lookaheadMs parameter', () => {
    // deadline 8min ahead. default lookahead (5min) excludes; lookahead=10min includes.
    const start = new Date(NOW + 9 * 60_000);
    const ev = buildEvent({ id: 'cust', start });
    expect(findNextPreciseDeadline([ev], NOW, [1], [])).toBeUndefined();
    expect(findNextPreciseDeadline([ev], NOW, [1], [], 10 * 60_000)).toBe(
      start.getTime() - 1 * 60_000,
    );
  });
});

describe('mergeAndPruneNotifiedKeys', () => {
  const buildPick = (id: string, start: Date, offset: number) => {
    const ev = buildEvent({ id, start });
    return { event: ev, offset, key: keyOf(id, start, offset) };
  };

  it('returns new picks when prevKeys is empty', () => {
    const start = new Date(NOW + 10 * 60_000);
    const pick = buildPick('a', start, 10);
    const result = mergeAndPruneNotifiedKeys([], [pick], [pick.event]);
    expect(result).toEqual([pick.key]);
  });

  it('deduplicates a key that appears in both prev and new picks', () => {
    const start = new Date(NOW + 10 * 60_000);
    const pick = buildPick('a', start, 10);
    const prev = [pick.key];
    const result = mergeAndPruneNotifiedKeys(prev, [pick], [pick.event]);
    expect(result).toEqual([pick.key]);
  });

  it('prunes keys whose occurrence is no longer in events', () => {
    const aStart = new Date(NOW + 10 * 60_000);
    const bStart = new Date(NOW + 20 * 60_000);
    const aPick = buildPick('a', aStart, 10);
    const bPick = buildPick('b', bStart, 10);
    // events now only contains b — a should be pruned
    const result = mergeAndPruneNotifiedKeys(
      [aPick.key, bPick.key],
      [],
      [bPick.event],
    );
    expect(result).toEqual([bPick.key]);
  });

  it('prunes every key when events is undefined', () => {
    const start = new Date(NOW + 10 * 60_000);
    const pick = buildPick('a', start, 10);
    const result = mergeAndPruneNotifiedKeys([pick.key], [], undefined);
    expect(result).toEqual([]);
  });

  it('keeps both keys when the same id has two occurrences with different starts', () => {
    const start1 = new Date(NOW + 10 * 60_000);
    const start2 = new Date(NOW + 10 * 60_000 + DAY_MS);
    const occ1 = buildPick('rec', start1, 10);
    const occ2 = buildPick('rec', start2, 10);
    const result = mergeAndPruneNotifiedKeys(
      [],
      [occ1, occ2],
      [occ1.event, occ2.event],
    );
    expect(result.sort()).toEqual([occ1.key, occ2.key].sort());
  });
});
