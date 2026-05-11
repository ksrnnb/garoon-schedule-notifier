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

// Pick events whose start time is exactly `notifyMinutesBefore` minutes from
// `now`. Comparisons happen on minute granularity to mirror the 1-minute alarm
// tick in background.ts.
export function pickEventsToNotify(
  events: ScheduleEvent[] | undefined,
  now: number,
  notifyMinutesBefore: number,
): ScheduleEvent[] {
  if (!events) return [];
  const curMin = Math.round(now / 60_000);
  return events.filter(ev => {
    const startMin = Math.floor(new Date(ev.start.dateTime).getTime() / 60_000);
    return curMin + notifyMinutesBefore === startMin;
  });
}
