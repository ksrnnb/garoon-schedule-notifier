import { ScheduleEvent } from '../api';

const DAY_MS = 86_400_000;

// Keep events from local "today 00:00" through `daysAhead` days from `now`.
// Mirrors the popup's need to render already-finished events from earlier
// today, so the lower bound is local midnight rather than `now`.
export function filterUpcomingEvents(
  events: ScheduleEvent[],
  now: number,
  daysAhead: number = 30,
): ScheduleEvent[] {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const horizon = daysAhead * DAY_MS;
  return events.filter(ev => {
    const start = new Date(ev.start.dateTime).getTime();
    return start >= todayStartMs && start - now < horizon;
  });
}

// Pick events whose start time is exactly one of `notifyMinutesBeforeList`
// minutes from `now`. Comparisons happen on minute granularity to mirror the
// 1-minute alarm tick in background.ts. Duplicate offsets are coalesced so an
// event won't be returned twice per tick.
export function pickEventsToNotify(
  events: ScheduleEvent[] | undefined,
  now: number,
  notifyMinutesBeforeList: number[],
): ScheduleEvent[] {
  if (!events || notifyMinutesBeforeList.length === 0) return [];
  const curMin = Math.round(now / 60_000);
  const offsets = new Set(notifyMinutesBeforeList);
  return events.filter(ev => {
    const startMin = Math.floor(new Date(ev.start.dateTime).getTime() / 60_000);
    return offsets.has(startMin - curMin);
  });
}
