import { zeroPad } from '../util';
import { ErrorResponse } from './ErrorResponse';
import { Method, ScheduleEvent } from './type';

// Format a local Date as ISO-8601 with the local UTC offset, e.g.
// "2026-04-24T23:59:59+09:00". The Garoon API requires a TZ-qualified
// timestamp.
function formatLocalISOWithOffset(d: Date): string {
  const offset = -d.getTimezoneOffset();
  return (
    d.getFullYear() +
    '-' +
    zeroPad(d.getMonth() + 1) +
    '-' +
    zeroPad(d.getDate()) +
    'T' +
    zeroPad(d.getHours()) +
    ':' +
    zeroPad(d.getMinutes()) +
    ':' +
    zeroPad(d.getSeconds()) +
    (offset < 0 ? '-' : '+') +
    zeroPad(Math.floor(Math.abs(offset) / 60)) +
    ':' +
    zeroPad(Math.abs(offset) % 60)
  );
}

// rangeEnd を「翌日 23:59:59」ではなく 7 日先まで広げているのは、API が
// `event.end < rangeEnd` で弾くため、出張・研修のような今日始まって数日後に
// 終わる予定を取りこぼさないため。7 日を超える予定は実運用上稀。
const RANGE_END_PADDING_DAYS = 7;

// Build the rangeStart query parameter for /schedule/events. Garoon's API
// filters "events whose start is *strictly after* rangeStart" (per docs), so
// to keep events starting exactly at today 00:00 inclusive we send
// "yesterday 23:59:59" local-time. JS Date normalises an underflowed seconds
// component, so month/year rollover (Jan 1 → Dec 31) is handled automatically.
export function buildScheduleEventsRangeStart(
  today: Date = new Date(),
): string {
  const d = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    0,
    0,
    -1,
  );
  return formatLocalISOWithOffset(d);
}

// Build the rangeEnd query parameter for /schedule/events: today + 7 days at
// 23:59:59 local-time. See RANGE_END_PADDING_DAYS for the rationale.
export function buildScheduleEventsRangeEnd(today: Date = new Date()): string {
  const d = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + RANGE_END_PADDING_DAYS,
    23,
    59,
    59,
  );
  return formatLocalISOWithOffset(d);
}

/**
 * Garoon API request client.
 *
 * @see https://developer.cybozu.io/hc/ja/articles/360000577946
 */
export class GaroonAPI {
  constructor(protected baseURL: string) {}

  protected async call<T>(method: Method, url: string): Promise<T> {
    const resp = await fetch(`${this.baseURL}/api/v1/${url}`, {
      method,
      headers: {
        'X-Requested-With': 'XMLHTTPRequest',
      },
      redirect: 'error',
    });

    if (resp.status !== 200) {
      throw new ErrorResponse(resp);
    }

    return resp.json();
  }

  async get<T>(url: string) {
    return this.call<T>('GET', url);
  }

  // see, https://developer.cybozu.io/hc/ja/articles/360000440583
  async getScheduleEvents() {
    const start = buildScheduleEventsRangeStart();
    const end = buildScheduleEventsRangeEnd();
    return this.get<{
      hasNext: boolean;
      events: ScheduleEvent[];
    }>(
      'schedule/events?limit=1000&orderBy=start%20asc&rangeStart=' +
        encodeURIComponent(start) +
        '&rangeEnd=' +
        encodeURIComponent(end),
    );
  }
}
