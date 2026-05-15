/**
 * Garoon Notificator background script.
 */

import {
  clearError,
  detectWake,
  filterUpcomingEvents,
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
    picks.map(({ event: ev, offset }, i) =>
      notifyEvent(
        ev,
        offset,
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
  url?: string,
  volume?: number,
) {
  const timeLabel = ev.isAllDay
    ? t('all_day')
    : `${timeString(new Date(ev.start.dateTime))} - ${timeString(new Date(ev.end.dateTime))}`;
  const title = t('notify_title_prefix', String(offsetMinutes)) + ev.subject;
  await notify({ title, message: timeLabel }, url);
  if (volume !== undefined) {
    await playChime(volume).catch(e => console.warn('playChime failed', e));
  }
}

// alarm / onStartup の両方から呼ばれる定期 tick。
// 順序: 条件付き update → lastAlarmPingedAt 保存 → notifyEvents → updateBadge。
//
// lastAlarmPingedAt を update() 後・notifyEvents() 前で保存する理由:
//   - update() 進行中に SW kill された場合: ping 未記録 → 次 tick で
//     detectWake=true となり強制 refresh で events を取り直せる
//   - 後段例外 (notifyEvents/updateBadge で throw): ping 記録済みのため
//     次 tick を「通常 tick」として動かせる (毎回 force refresh の浪費を避ける)
export async function tick() {
  const now = Date.now();
  try {
    const { refreshInMinutes, lastUpdate, lastAlarmPingedAt } =
      await store.load();
    const isWaking = detectWake(now, lastAlarmPingedAt);
    const minutes = Math.round((now - (lastUpdate || 0)) / 60_000);

    if (isWaking || refreshInMinutes <= minutes) {
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
  } catch (e) {
    console.warn('caught error', e instanceof Error ? e : JSON.stringify(e));
  }
}

function run() {
  chrome.runtime.onInstalled.addListener(details => {
    console.info(`installed reason: ${details.reason}`);
    if (details.reason === 'install') {
      store.reset();
    }
  });

  initNotificationEvent();

  chrome.alarms.onAlarm.addListener(tick);
  chrome.runtime.onStartup.addListener(tick);

  message.listen(message.Type.Update, update);

  chrome.alarms.create('watchNotification', {
    periodInMinutes: 1,
  });
}

run();
