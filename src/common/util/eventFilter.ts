import { ScheduleEvent } from '../api';

const DAY_MS = 86_400_000;

// 開始から GRACE_MS 以上経過した予定は通知しない。alarm ドリフトや短いスリープ
// 復帰の取りこぼしを救う上限。これより古い予定を救うと、長時間スリープ後に
// 「半日前の予定」が一斉に鳴るような UX 退行を招くため境界として固定する。
export const GRACE_MS = 10 * 60_000;

export interface NotifyPick {
  event: ScheduleEvent;
  offset: number;
  key: string;
}

// Keep events from local "today 00:00" through `daysAhead` days from `now`.
// Lower bound is local midnight (not `now`) so the popup can render
// already-finished events from earlier today. Upper bound default is 1 day:
// the only consumers of stored `events` are the popup (today only), the
// badge (today only), and notifications (offset capped by MAX_NOTIFY_MINUTES
// = 60min in options.ts) — anything farther out is dead weight in storage.
export function filterUpcomingEvents(
  events: ScheduleEvent[],
  now: number,
  daysAhead: number = 1,
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

// キー組み立ては 1 箇所に集約する。pickEventsToNotify と
// mergeAndPruneNotifiedKeys の双方が同じフォーマットに依存するため、
// 片方を変えたときの format drift を防ぐ。
function eventKeyPrefix(ev: ScheduleEvent): string {
  return `${ev.id}:${new Date(ev.start.dateTime).getTime()}`;
}

function notifyKey(ev: ScheduleEvent, offset: number): string {
  return `${eventKeyPrefix(ev)}:${offset}`;
}

// 通知すべき (event, offset) ペアを返す。判定は半開区間:
//   通知期限 (start - offset*60s) を過ぎている かつ
//   開始から GRACE_MS 以内 かつ
//   その (event, offset) キーがまだ通知済みでない。
// 分の完全一致ではなく区間判定にすることで、alarm 遅延や短いスリープ復帰でも
// 取りこぼさない。dedup は呼び出し側が Store.notifiedKeys を渡すことで成立する。
export function pickEventsToNotify(
  events: ScheduleEvent[] | undefined,
  now: number,
  notifyMinutesBeforeList: number[],
  notifiedKeys: ReadonlySet<string> | readonly string[],
): NotifyPick[] {
  if (!events || notifyMinutesBeforeList.length === 0) return [];
  const notified =
    notifiedKeys instanceof Set ? notifiedKeys : new Set(notifiedKeys);
  const offsets = Array.from(new Set(notifyMinutesBeforeList));
  const out: NotifyPick[] = [];
  for (const ev of events) {
    const startMs = new Date(ev.start.dateTime).getTime();
    const delta = startMs - now;
    if (delta < -GRACE_MS) continue;
    for (const offset of offsets) {
      if (delta > offset * 60_000) continue;
      const key = notifyKey(ev, offset);
      if (notified.has(key)) continue;
      out.push({ event: ev, offset, key });
    }
  }
  return out;
}

// 既存キーと今回 picks をマージし、現行 events に存在しない occurrence のキーを
// 剪定する。events 側は filterUpcomingEvents で「今日 00:00 〜 1 日先」に
// 絞られているため、昨日以前や 1 日より先のキーは自然に落ちる。
export function mergeAndPruneNotifiedKeys(
  prevKeys: readonly string[],
  newPicks: readonly NotifyPick[],
  events: readonly ScheduleEvent[] | undefined,
): string[] {
  const validPrefixes = new Set((events ?? []).map(eventKeyPrefix));
  const merged = new Set<string>([...prevKeys, ...newPicks.map(p => p.key)]);
  return Array.from(merged).filter(k => {
    const lastColon = k.lastIndexOf(':');
    if (lastColon < 0) return false;
    return validPrefixes.has(k.slice(0, lastColon));
  });
}
