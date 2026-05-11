import { describe, expect, it } from 'vitest';
import { filterUpcomingEvents, pickEventsToNotify } from '../eventFilter';
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

  it('keeps an event ~30 days from now minus 1ms (strict less-than horizon)', () => {
    const justInside = buildEvent({
      id: 'inside',
      start: new Date(NOW + 30 * DAY_MS - 1),
    });
    const result = filterUpcomingEvents([justInside], NOW);
    expect(result.map(e => e.id)).toEqual(['inside']);
  });

  it('drops an event exactly 30 days from now (strict horizon)', () => {
    const onHorizon = buildEvent({
      id: 'edge',
      start: new Date(NOW + 30 * DAY_MS),
    });
    expect(filterUpcomingEvents([onHorizon], NOW)).toEqual([]);
  });

  it('drops an event 35 days from now', () => {
    const farFuture = buildEvent({
      id: 'far',
      start: new Date(NOW + 35 * DAY_MS),
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

describe('pickEventsToNotify', () => {
  it('returns [] when events is undefined', () => {
    expect(pickEventsToNotify(undefined, NOW, 10)).toEqual([]);
  });

  it('matches an event whose start is exactly notifyMinutesBefore from now', () => {
    const tenMinFromNow = buildEvent({
      id: 't10',
      subject: 'meeting',
      start: new Date(NOW + 10 * 60_000),
    });
    const result = pickEventsToNotify([tenMinFromNow], NOW, 10);
    expect(result.map(e => e.id)).toEqual(['t10']);
  });

  it('rejects an event one minute too early', () => {
    const nineMin = buildEvent({
      id: 't9',
      subject: 'meeting',
      start: new Date(NOW + 9 * 60_000),
    });
    expect(pickEventsToNotify([nineMin], NOW, 10)).toEqual([]);
  });

  it('rejects an event one minute too late', () => {
    const elevenMin = buildEvent({
      id: 't11',
      subject: 'meeting',
      start: new Date(NOW + 11 * 60_000),
    });
    expect(pickEventsToNotify([elevenMin], NOW, 10)).toEqual([]);
  });

  it('matches at duration=0 when start === current minute', () => {
    const right_now_min = buildEvent({
      id: 'now',
      subject: 'meeting',
      start: new Date(Math.floor(NOW / 60_000) * 60_000),
    });
    const result = pickEventsToNotify([right_now_min], NOW, 0);
    expect(result.map(e => e.id)).toEqual(['now']);
  });

  it('returns multiple events when several match the same minute', () => {
    const a = buildEvent({
      id: 'a',
      subject: 'A',
      start: new Date(NOW + 10 * 60_000),
    });
    const b = buildEvent({
      id: 'b',
      subject: 'B',
      start: new Date(NOW + 10 * 60_000 + 30_000),
    });
    const result = pickEventsToNotify([a, b], NOW, 10);
    // b's startMin = floor((NOW + 10*60000 + 30000)/60000) = floor(NOW/60000) + 10
    // i.e. floor truncates the trailing 30s → still matches.
    expect(result.map(e => e.id).sort()).toEqual(['a', 'b']);
  });
});
