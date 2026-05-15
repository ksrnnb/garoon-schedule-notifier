/**
 * Garoon Notificator background script.
 */

import {
  clearError,
  detectWake,
  filterUpcomingEvents,
  findNextPreciseDeadline,
  initNotificationEvent,
  mergeAndPruneNotifiedKeys,
  notify,
  pickEventsToNotify,
  playChime,
  requireAuth,
  scheduleURL,
  setError,
  t,
  timeString,
  updateBadge,
} from './common';
import { GaroonAPI, ScheduleEvent, ErrorResponse } from './common/api';
import * as store from './common/store';
import * as message from './common/background';

// alarm 名は 2 種類。periodic は 1 分周期のフェイルセーフ、precise は
// 「次の通知 deadline」に合わせて入れる one-shot。両方とも tick() を呼ぶ。
const WATCH_ALARM_NAME = 'watchNotification';
const PRECISE_ALARM_NAME = 'preciseNotify';

async function update() {
  try {
    const { baseURL } = await store.load();
    if (!baseURL) {
      return await setError(t('err_no_base_url'));
    }

    await updateScheduleEvents(baseURL);

    await store.save({ lastUpdate: Date.now() });

    await clearError();
  } catch (e) {
    if (e instanceof ErrorResponse && e.status() === 401) {
      await requireAuth();
      return;
    }
    throw e;
  }
}

async function updateScheduleEvents(baseURL: string) {
  const data = await new GaroonAPI(baseURL).getScheduleEvents();
  const events = filterUpcomingEvents(data.events, Date.now());
  await store.save({ events });
}

// 通知を発火し、次に保存すべき notifiedKeys を返す。保存は呼び出し側 (tick)
// が 1 回にまとめる (popup 由来の save とのレース窓を狭めるため)。
// 変更なし (発火 0 件 かつ 剪定差分なし) の場合は undefined を返す。
async function notifyEvents(): Promise<string[] | undefined> {
  const {
    events,
    notifyMinutesBeforeList,
    notifiedKeys,
    playsSound,
    soundVolume,
    baseURL,
  } = await store.load();

  const prev = notifiedKeys ?? [];
  const picks = pickEventsToNotify(
    events,
    Date.now(),
    notifyMinutesBeforeList ?? [],
    prev,
  );

  // バースト時 (同 tick で複数件まとめて通知) はチャイム連打を避けるため
  // 先頭 1 件だけ playChime に volume を渡す。通知本体は全件出す。
  //
  // notifyEvent は await する。fire-and-forget だと chrome.notifications.create
  // の callback 完了前に SW が落ちて通知が出ない (or 後段の notifiedKeys 保存
  // との順序が壊れて取りこぼし) リスクがあるため。1 件の失敗で他を巻き込まない
  // よう Promise.all の各要素を .catch でガードする。
  const playVolume = playsSound ? soundVolume : undefined;
  await Promise.all(
    picks.map(({ event: ev, offset, key }, i) =>
      notifyEvent(
        ev,
        offset,
        `grn:event:${key}`,
        baseURL ? scheduleURL(baseURL, ev.id) : undefined,
        i === 0 ? playVolume : undefined,
      ).catch(e => console.warn('notifyEvent failed', e)),
    ),
  );

  // picks=0 でも events が入れ替わって stale なキーが残っていれば剪定したい。
  // 常に merge+prune を走らせ、結果が prev と要素数一致なら変更なしとみなす。
  const merged = mergeAndPruneNotifiedKeys(prev, picks, events);
  if (picks.length === 0 && merged.length === prev.length) return undefined;
  return merged;
}

async function notifyEvent(
  ev: ScheduleEvent,
  offsetMinutes: number,
  notificationId: string,
  url?: string,
  volume?: number,
) {
  const timeLabel = ev.isAllDay
    ? t('all_day')
    : `${timeString(new Date(ev.start.dateTime))} - ${timeString(new Date(ev.end.dateTime))}`;
  const title = t('notify_title_prefix', String(offsetMinutes)) + ev.subject;
  // notificationId は dedup key (= `grn:event:${eventId}:${startMs}:${offset}`)。
  // SW kill 等で notifiedKeys 保存前に再 fire しても、chrome.notifications 側で
  // 同 ID として吸収され toast は積み上がらない。
  await notify({ title, message: timeLabel }, url, notificationId);
  if (volume !== undefined) {
    await playChime(volume).catch(e => console.warn('playChime failed', e));
  }
}

// alarm / onStartup の両方から呼ばれる定期 tick。
// 順序: 条件付き update → lastAlarmPingedAt 保存 → notifyEvents → updateBadge →
//       schedulePreciseAlarm。
//
// lastAlarmPingedAt を update() 後・notifyEvents() 前で保存する理由:
//   - update() 進行中に SW kill された場合: ping 未記録 → 次 tick で
//     detectWake=true となり強制 refresh で events を取り直せる
//   - 後段例外 (notifyEvents/updateBadge で throw): ping 記録済みのため
//     次 tick を「通常 tick」として動かせる (毎回 force refresh の浪費を避ける)
//
// forceUpdate=true は precise alarm 経由の呼び出し用。直前に API を叩き直して
// 「削除済みの予定」を events から消し、誤通知を避ける。
//
// 並行呼び出し対策: tickInFlight Promise を保持し、走行中の tick があれば
// それを返す。periodic と precise が近接して発火した場合に notifiedKeys の
// load→save が race するのを防ぐ。precise が捨てられても、走行中の tick が
// 末尾で schedulePreciseAlarm を呼ぶので次の精密 alarm は仕掛け直される。
let tickInFlight: Promise<void> | null = null;

export function tick(opts: { forceUpdate?: boolean } = {}): Promise<void> {
  if (tickInFlight) return tickInFlight;
  tickInFlight = doTick(opts).finally(() => {
    tickInFlight = null;
  });
  return tickInFlight;
}

async function doTick(opts: { forceUpdate?: boolean }) {
  const now = Date.now();
  try {
    const { refreshInMinutes, lastUpdate, lastAlarmPingedAt } =
      await store.load();
    const isWaking = detectWake(now, lastAlarmPingedAt);
    const minutes = Math.round((now - (lastUpdate || 0)) / 60_000);

    if (opts.forceUpdate || isWaking || refreshInMinutes <= minutes) {
      try {
        await update();
      } catch (e) {
        // update() 失敗時もキャッシュした events で通知判定は続行する
        console.warn('update failed; continuing with cached events', e);
      }
    }

    await store.save({ lastAlarmPingedAt: now });

    const nextNotifiedKeys = await notifyEvents();
    if (nextNotifiedKeys !== undefined) {
      await store.save({ notifiedKeys: nextNotifiedKeys });
    }

    await updateBadge();
    await schedulePreciseAlarm();
  } catch (e) {
    console.warn('caught error', e instanceof Error ? e : JSON.stringify(e));
  }
}

// 「次に発火すべき (event, offset) ペア」の deadline に one-shot alarm を入れる。
// 該当なしなら既存の precise alarm を片付けるだけ。periodic tick の末尾と
// precise tick の末尾で呼ばれ、毎回最新の events/notifiedKeys を基準に
// 仕掛け直すので、予定の追加・削除・変更にも追従する。
async function schedulePreciseAlarm() {
  const { events, notifyMinutesBeforeList, notifiedKeys } = await store.load();
  const deadline = findNextPreciseDeadline(
    events,
    Date.now(),
    notifyMinutesBeforeList ?? [],
    notifiedKeys ?? [],
  );
  if (deadline === undefined) {
    await chrome.alarms.clear(PRECISE_ALARM_NAME);
    return;
  }
  await chrome.alarms.create(PRECISE_ALARM_NAME, { when: deadline });
}

// SW は MV3 で頻繁に再起動する。`chrome.alarms.create` を同名で再呼出すると
// 既存 alarm が破棄されて次回発火時刻がリセットされるため、起動の度に呼ぶと
// 「いつまでも 1 分待ち」を繰り返しかねない。get で存在確認してから作る。
// precise alarm はスケジュール対象の deadline が変わり得るので、ここでは
// 触らず schedulePreciseAlarm() 側に任せる。
async function ensureWatchAlarm() {
  const existing = await chrome.alarms.get(WATCH_ALARM_NAME);
  if (existing) return;
  await chrome.alarms.create(WATCH_ALARM_NAME, { periodInMinutes: 1 });
}

function run() {
  chrome.runtime.onInstalled.addListener(details => {
    console.info(`installed reason: ${details.reason}`);
    if (details.reason === 'install') {
      store.reset();
    }
  });

  initNotificationEvent();

  // MV3 SW: イベントリスナーは top-level で同期登録する必要がある。
  // alarm の存在確認/作成はその後に async で済ませる。
  // precise alarm は forceUpdate: true で tick を呼び、直前に API を叩き直して
  // 削除済みの予定を除外する。periodic alarm は通常モード。
  // 注: リスナーは tick() の Promise を返す必要がある (MV3 は Promise を返す
  // リスナーが pending な間 SW を生かす)。中括弧つき arrow で return を省略
  // すると undefined を返してしまい、tick 完了前に SW が落ちうる。
  chrome.alarms.onAlarm.addListener(alarm =>
    alarm.name === PRECISE_ALARM_NAME ? tick({ forceUpdate: true }) : tick(),
  );
  chrome.runtime.onStartup.addListener(() => tick());

  message.listen(message.Type.Update, update);

  ensureWatchAlarm().catch(e => console.warn('ensureWatchAlarm failed', e));
}

run();
