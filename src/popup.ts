import {
  t,
  localizeHTML,
  newElem,
  scheduleURL,
  timeString,
} from './common/util';
import { ScheduleEvent } from './common/api';
import * as store from './common/store';
import * as bg from './common/background';

function init() {
  initDOM();
  render();
}

function initDOM() {
  localizeHTML();
  settingButton().addEventListener('click', openSettings);
  refreshButton().addEventListener('click', refresh);
  portalOpener().addEventListener('click', openPortal);
}

function render() {
  setError();
  setEvents();
}

const elem = <T extends HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;

const settingButton = () => elem<HTMLButtonElement>('.setting-button');
const refreshContainer = () => elem<HTMLDivElement>('.refresh-container');
const refreshButton = () => elem<HTMLButtonElement>('.refresh-button');
const portalOpener = () => elem<HTMLAnchorElement>('.portal-opener');
const errorContainer = () => elem<HTMLDivElement>('.error-container');
const errorMessage = () => elem<HTMLDivElement>('.error-message');
const eventsList = () =>
  elem<HTMLUListElement>('.events-list:not(.allday-events-list)');
const allDayEventsContainer = () =>
  elem<HTMLElement>('.allday-events-container');
const allDayEventsList = () => elem<HTMLUListElement>('.allday-events-list');
const noEvents = () => elem<HTMLParagraphElement>('.no-events');

async function refresh() {
  const container = refreshContainer();
  const btn = refreshButton();
  container.dataset.isLoading = 'true';
  btn.disabled = true;
  try {
    await bg.update();
  } catch (e) {
    console.warn('refresh error', e);
  }
  container.dataset.isLoading = '';
  btn.disabled = false;

  render();
}

async function openPortal() {
  const { baseURL } = await store.load();
  chrome.tabs.create({
    url: baseURL,
  });
}

async function openSettings() {
  chrome.tabs.create({
    url: './options.html',
  });
}

async function setError() {
  const { error } = await store.load();
  if (error) {
    errorMessage().textContent = error;
  }
  errorContainer().hidden = !error;
}

export function isTodayEvent(
  ev: ScheduleEvent,
  todayStart: Date,
  tomorrowStart: Date,
): boolean {
  const start = new Date(ev.start.dateTime).getTime();
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime).getTime() : start;
  const todayStartMs = todayStart.getTime();
  // Same compound boundary as filterUpcomingEvents (see comment there): an
  // event is "today" if it starts today (inclusive of 00:00) or if it
  // started earlier but still ends after today began. Strict `>` on the
  // past side drops yesterday-ending-exactly-at-midnight events.
  const overlapsToday = start >= todayStartMs || end > todayStartMs;
  return start < tomorrowStart.getTime() && overlapsToday;
}

export function getEventState(
  ev: ScheduleEvent,
  now: number,
): { isPast: boolean; isOngoing: boolean } {
  const startTime = new Date(ev.start.dateTime).getTime();
  const endTime = ev.end?.dateTime
    ? new Date(ev.end.dateTime).getTime()
    : startTime;
  const isPast = !ev.isAllDay && endTime <= now;
  const isOngoing = !ev.isAllDay && !isPast && startTime <= now;
  return { isPast, isOngoing };
}

async function setEvents() {
  const { events, baseURL } = await store.load();
  const list = eventsList();
  const allDayList = allDayEventsList();
  list.replaceChildren();
  allDayList.replaceChildren();

  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const todays = (events || []).filter(ev =>
    isTodayEvent(ev, todayStart, tomorrowStart),
  );

  const allDays = todays.filter(ev => ev.isAllDay);
  const timed = todays.filter(ev => !ev.isAllDay);

  allDayEventsContainer().hidden = allDays.length === 0;
  allDays.forEach(ev =>
    allDayList.appendChild(buildEventItem(ev, baseURL, now)),
  );

  noEvents().hidden = todays.length > 0;
  timed.forEach(ev => list.appendChild(buildEventItem(ev, baseURL, now)));
}

function buildEventItem(
  ev: ScheduleEvent,
  baseURL: string | undefined,
  now: number,
): HTMLLIElement {
  const start = new Date(ev.start.dateTime);
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
  const { isPast, isOngoing } = getEventState(ev, now);

  const timeLabel = ev.isAllDay
    ? t('all_day')
    : end && !ev.isStartOnly
      ? `${timeString(start)} - ${timeString(end)}`
      : timeString(start);

  const link = newElem('a', {
    className: 'event-link',
    children: [
      newElem('span', { className: 'event-time', children: timeLabel }),
      newElem('span', { className: 'event-subject', children: ev.subject }),
    ],
  });
  if (baseURL) {
    const href = scheduleURL(baseURL, ev.id);
    link.href = href;
    link.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: href });
    });
  }

  const stateClass = isPast
    ? ' event-item--past'
    : isOngoing
      ? ' event-item--ongoing'
      : '';

  return newElem('li', {
    className: `event-item${stateClass}`,
    children: link,
  });
}

document.addEventListener('DOMContentLoaded', init);
