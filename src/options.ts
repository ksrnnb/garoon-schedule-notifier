import * as store from './common/store';
import { defaultConfig } from './common/store';

import {
  isValidBaseURL,
  localizeHTML,
  newElem,
  playChime,
  t,
} from './common/util';

const MIN_NOTIFY_MINUTES = 1;
const MAX_NOTIFY_MINUTES = 60;
const MAX_NOTIFY_TIMINGS = 10;

interface FormSnapshot {
  baseURL: string;
  notifyMinutesBeforeList: number[];
  playsSound: boolean;
  soundVolumePercent: number;
}

function input(
  name: string,
  defaultValue?: string | boolean | undefined,
): HTMLInputElement {
  const elem = document.querySelector(
    `input[name=${name}]`,
  ) as HTMLInputElement;
  if (typeof defaultValue === 'string') {
    elem.value = defaultValue;
  } else if (typeof defaultValue === 'boolean') {
    elem.checked = defaultValue;
  }
  return elem;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return defaultConfig.soundVolume!;
  return Math.max(0, Math.min(1, n));
}

function buildNotifyMinutesRow(value: number): HTMLLIElement {
  const numberInput = newElem('input', { className: 'input' });
  numberInput.type = 'number';
  numberInput.name = 'notify-minutes-before';
  numberInput.min = `${MIN_NOTIFY_MINUTES}`;
  numberInput.max = `${MAX_NOTIFY_MINUTES}`;
  numberInput.required = true;
  numberInput.value = `${value}`;

  const unit = newElem('span', {
    className: 'input-group-text',
    children: t('minutes_before_short'),
  });

  const inputGroup = newElem('div', {
    className: 'input-group notify-minutes-before',
    children: [numberInput, unit],
  });

  const removeButton = newElem('button', {
    className: 'button-icon remove-notify-minutes',
  });
  removeButton.type = 'button';
  removeButton.setAttribute('aria-label', t('opt_remove_notification'));
  // Lucide trash-2 (ISC) https://lucide.dev/icons/trash-2
  removeButton.innerHTML =
    '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10 11v6"/>' +
    '<path d="M14 11v6"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M3 6h18"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '</svg>';

  return newElem('li', {
    className: 'notify-minutes-row',
    children: [inputGroup, removeButton],
  });
}

function readNotifyMinutesList(listElem: HTMLElement): number[] {
  const rows = listElem.querySelectorAll<HTMLInputElement>(
    'input[name=notify-minutes-before]',
  );
  const values: number[] = [];
  rows.forEach(r => {
    const n = parseInt(r.value, 10);
    if (
      !Number.isNaN(n) &&
      n >= MIN_NOTIFY_MINUTES &&
      n <= MAX_NOTIFY_MINUTES
    ) {
      values.push(n);
    }
  });
  return Array.from(new Set(values));
}

function validateNotifyMinutesList(listElem: HTMLElement) {
  const inputs = listElem.querySelectorAll<HTMLInputElement>(
    'input[name=notify-minutes-before]',
  );
  const counts = new Map<string, number>();
  inputs.forEach(i => counts.set(i.value, (counts.get(i.value) ?? 0) + 1));
  inputs.forEach(i => {
    i.setCustomValidity(
      (counts.get(i.value) ?? 0) > 1 ? t('err_duplicate_notify_minutes') : '',
    );
  });
}

function updateRemoveButtonsEnabled(listElem: HTMLElement) {
  const rows = listElem.querySelectorAll<HTMLLIElement>('.notify-minutes-row');
  const onlyOne = rows.length <= 1;
  rows.forEach(row => {
    const btn = row.querySelector<HTMLButtonElement>('.remove-notify-minutes');
    if (btn) btn.disabled = onlyOne;
  });
}

function updateAddButtonEnabled(
  listElem: HTMLElement,
  addButton: HTMLButtonElement,
) {
  const rows = listElem.querySelectorAll('.notify-minutes-row');
  addButton.disabled = rows.length >= MAX_NOTIFY_TIMINGS;
}

async function init() {
  localizeHTML();

  const v = await store.load();

  const baseURL = input('base-url', v.baseURL);
  baseURL.addEventListener('input', () => baseURL.setCustomValidity(''));

  const notifyMinutesList = document.querySelector<HTMLUListElement>(
    '#notify-minutes-list',
  )!;
  const addNotifyMinutesButton = document.querySelector<HTMLButtonElement>(
    'button[name=add-notify-minutes]',
  )!;
  const cancelButton = document.querySelector<HTMLButtonElement>(
    'button[name=cancel]',
  )!;

  const initialList =
    v.notifyMinutesBeforeList && v.notifyMinutesBeforeList.length > 0
      ? v.notifyMinutesBeforeList
      : defaultConfig.notifyMinutesBeforeList!;
  initialList.forEach(min => {
    notifyMinutesList.appendChild(buildNotifyMinutesRow(min));
  });
  updateRemoveButtonsEnabled(notifyMinutesList);
  updateAddButtonEnabled(notifyMinutesList, addNotifyMinutesButton);
  validateNotifyMinutesList(notifyMinutesList);

  const playsSound = input('plays-sound', v.playsSound);
  const soundVolume = input(
    'sound-volume',
    `${Math.round(clamp01(v.soundVolume ?? defaultConfig.soundVolume!) * 100)}`,
  );
  const soundVolumeValue = document.querySelector<HTMLSpanElement>(
    '.sound-volume-value',
  )!;
  const testSoundButton = document.querySelector<HTMLButtonElement>(
    'button[name=test-sound]',
  )!;

  const updateVolumeLabel = () => {
    soundVolumeValue.textContent = `${soundVolume.value}%`;
  };
  const updateSoundControlsEnabled = () => {
    const enabled = playsSound.checked;
    soundVolume.disabled = !enabled;
    testSoundButton.disabled = !enabled;
  };

  updateVolumeLabel();
  updateSoundControlsEnabled();

  let savedSnapshot: FormSnapshot = {
    baseURL: baseURL.value,
    notifyMinutesBeforeList: [...initialList],
    playsSound: playsSound.checked,
    soundVolumePercent: parseInt(soundVolume.value, 10),
  };

  const rawFormState = (): string => {
    const rows = Array.from(
      notifyMinutesList.querySelectorAll<HTMLInputElement>(
        'input[name=notify-minutes-before]',
      ),
    ).map(r => r.value);
    return JSON.stringify({
      baseURL: baseURL.value,
      notifyMinutes: rows,
      playsSound: playsSound.checked,
      soundVolume: soundVolume.value,
    });
  };

  let baselineRaw = rawFormState();
  const updateCancelButtonEnabled = () => {
    cancelButton.disabled = rawFormState() === baselineRaw;
  };
  updateCancelButtonEnabled();

  const applySnapshot = (s: FormSnapshot) => {
    baseURL.value = s.baseURL;
    baseURL.setCustomValidity('');

    notifyMinutesList.replaceChildren();
    s.notifyMinutesBeforeList.forEach(min => {
      notifyMinutesList.appendChild(buildNotifyMinutesRow(min));
    });
    updateRemoveButtonsEnabled(notifyMinutesList);
    updateAddButtonEnabled(notifyMinutesList, addNotifyMinutesButton);
    validateNotifyMinutesList(notifyMinutesList);

    playsSound.checked = s.playsSound;
    soundVolume.value = `${s.soundVolumePercent}`;
    updateVolumeLabel();
    updateSoundControlsEnabled();
  };

  baseURL.addEventListener('input', updateCancelButtonEnabled);

  addNotifyMinutesButton.addEventListener('click', () => {
    if (
      notifyMinutesList.querySelectorAll('.notify-minutes-row').length >=
      MAX_NOTIFY_TIMINGS
    ) {
      return;
    }
    notifyMinutesList.appendChild(
      buildNotifyMinutesRow(defaultConfig.notifyMinutesBeforeList![0]),
    );
    updateRemoveButtonsEnabled(notifyMinutesList);
    updateAddButtonEnabled(notifyMinutesList, addNotifyMinutesButton);
    validateNotifyMinutesList(notifyMinutesList);
    updateCancelButtonEnabled();
  });

  notifyMinutesList.addEventListener('click', ev => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLButtonElement>('.remove-notify-minutes');
    if (!btn) return;
    const row = btn.closest<HTMLLIElement>('.notify-minutes-row');
    if (!row) return;
    if (notifyMinutesList.querySelectorAll('.notify-minutes-row').length <= 1) {
      return;
    }
    row.remove();
    updateRemoveButtonsEnabled(notifyMinutesList);
    updateAddButtonEnabled(notifyMinutesList, addNotifyMinutesButton);
    validateNotifyMinutesList(notifyMinutesList);
    updateCancelButtonEnabled();
  });

  notifyMinutesList.addEventListener('input', ev => {
    const target = ev.target as HTMLElement | null;
    if (target?.matches('input[name=notify-minutes-before]')) {
      validateNotifyMinutesList(notifyMinutesList);
      updateCancelButtonEnabled();
    }
  });

  soundVolume.addEventListener('input', updateVolumeLabel);
  soundVolume.addEventListener('input', updateCancelButtonEnabled);
  playsSound.addEventListener('change', updateSoundControlsEnabled);
  playsSound.addEventListener('change', updateCancelButtonEnabled);

  testSoundButton.addEventListener('click', async () => {
    const volume = clamp01(parseInt(soundVolume.value, 10) / 100);
    try {
      await playChime(volume);
    } catch (e) {
      console.warn('test play failed', e);
    }
  });

  cancelButton.addEventListener('click', () => {
    applySnapshot(savedSnapshot);
    baselineRaw = rawFormState();
    updateCancelButtonEnabled();
  });

  document
    .querySelector('#ext-options')!
    .addEventListener('submit', async ev => {
      ev.preventDefault();
      if (!isValidBaseURL(baseURL.value)) {
        baseURL.setCustomValidity(t('err_invalid_base_url'));
        baseURL.reportValidity();
        return;
      }
      baseURL.setCustomValidity('');

      const list = readNotifyMinutesList(notifyMinutesList);
      const notifyMinutesBeforeList =
        list.length > 0 ? list : defaultConfig.notifyMinutesBeforeList!;

      const soundVolumePercent = parseInt(soundVolume.value, 10);

      await store.save({
        baseURL: baseURL.value,
        notifyMinutesBeforeList,
        playsSound: playsSound.checked,
        soundVolume: clamp01(soundVolumePercent / 100),
      });

      savedSnapshot = {
        baseURL: baseURL.value,
        notifyMinutesBeforeList: [...notifyMinutesBeforeList],
        playsSound: playsSound.checked,
        soundVolumePercent,
      };
      baselineRaw = rawFormState();
      updateCancelButtonEnabled();

      const saved = document.querySelector<HTMLSpanElement>('.saved')!;
      saved.hidden = false;
      saved.classList.add('fade-out');
      setTimeout(() => {
        saved.classList.remove('fade-out');
        saved.hidden = true;
      }, 2000);
    });
}

document.addEventListener('DOMContentLoaded', init);
