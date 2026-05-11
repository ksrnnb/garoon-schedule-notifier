/**
 * Garoon Notificator background script.
 */

import {
  clearError,
  filterUpcomingEvents,
  initNotificationEvent,
  notify,
  pickEventsToNotify,
  playChime,
  requireAuth,
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
      requireAuth();
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

async function notifyEvents() {
  const { events, notifyMinutesBefore, playsSound, soundVolume, baseURL } =
    await store.load();

  const duration = notifyMinutesBefore || 0;

  pickEventsToNotify(events, Date.now(), duration).forEach(ev => {
    notifyEvent(
      ev,
      baseURL && `${baseURL.replace(/\/+$/, '')}/schedule/view?event=${ev.id}`,
      playsSound ? soundVolume : undefined,
    );
  });
}

async function notifyEvent(ev: ScheduleEvent, url?: string, volume?: number) {
  const timeLabel = ev.isAllDay
    ? t('all_day')
    : `${timeString(new Date(ev.start.dateTime))} - ${timeString(new Date(ev.end.dateTime))}`;
  notify(
    {
      title: ev.subject,
      message: timeLabel,
    },
    {
      onClicked: () => {
        if (url) {
          chrome.tabs.create({
            url,
          });
        }
      },
    },
  );
  if (volume !== undefined) {
    playChime(volume).catch(e => console.warn('playChime failed', e));
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

  chrome.alarms.onAlarm.addListener(async alarm => {
    try {
      await notifyEvents();

      const { refreshInMinutes, lastUpdate } = await store.load();
      const minutes = Math.round((Date.now() - (lastUpdate || 0)) / 60000);

      if (refreshInMinutes <= minutes) {
        await update();

        const { lastUpdate: last, events, error } = await store.load();

        console.info(
          'update',
          timeString(new Date()),
          refreshInMinutes <= minutes,
          {
            update: last,
            error,
            events,
          },
        );
      }

      await updateBadge();
    } catch (e) {
      console.warn('caught error', e instanceof Error ? e : JSON.stringify(e));
    }
  });

  message.listen(message.Type.Update, update);

  chrome.alarms.create('watchNotification', {
    periodInMinutes: 1,
  });

  update();
}

run();
