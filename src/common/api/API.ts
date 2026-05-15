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

// rangeStart 側も rangeEnd と対称に 7 日遡る。3 日前に始まって今日も
// 継続中、のような multi-day 予定 (出張・研修・連泊オンコール等) を
// 救うため。API は strict `start > rangeStart` で弾くので、ここで遡って
// おかないと「3 日前開始のワークショップが popup から消える」状態になる。
// ローカルではこのあと filterUpcomingEvents が「今日と無関係な過去予定」を
// 落とす (start >= today 00:00 || end > today 00:00) ので、storage が膨張
// する心配は無い。
const RANGE_START_PADDING_DAYS = 7;

// Build the rangeStart query parameter for /schedule/events. Garoon's API
// filters "events whose start is *strictly after* rangeStart" (per docs), so
// to keep events starting exactly at (today - RANGE_START_PADDING_DAYS) 00:00
// inclusive we send the local 00:00:-1 (= one second before midnight) of
// that day. JS Date normalises underflowed seconds, so month/year rollover
// (Jan 1 → Dec 31) is handled automatically.
export function buildScheduleEventsRangeStart(
  today: Date = new Date(),
): string {
  const d = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - RANGE_START_PADDING_DAYS,
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
  //
  // ページネーション: API は limit/offset 形式で hasNext を返す。1 ページ
  // 1000 件 + 8〜15 日窓では通常 1 ページに収まるが、超ヘビーユーザーの
  // 取りこぼし防止に hasNext を見て次ページを取りに行く。MAX_PAGES で
  // 暴走防止の上限を切る (1000 × 10 = 1万件)。
  async getScheduleEvents(): Promise<{ events: ScheduleEvent[] }> {
    const rangeStart = buildScheduleEventsRangeStart();
    const rangeEnd = buildScheduleEventsRangeEnd();
    const LIMIT = 1000;
    const MAX_PAGES = 10;
    const all: ScheduleEvent[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * LIMIT;
      const qs =
        `limit=${LIMIT}` +
        `&offset=${offset}` +
        `&orderBy=${encodeURIComponent('start asc')}` +
        `&rangeStart=${encodeURIComponent(rangeStart)}` +
        `&rangeEnd=${encodeURIComponent(rangeEnd)}`;
      const data = await this.get<{
        hasNext: boolean;
        events: ScheduleEvent[];
      }>(`schedule/events?${qs}`);
      all.push(...data.events);
      if (!data.hasNext) {
        return { events: all };
      }
    }
    console.warn(
      `getScheduleEvents: hit MAX_PAGES (${MAX_PAGES}); some events may be missing`,
    );
    return { events: all };
  }
}
