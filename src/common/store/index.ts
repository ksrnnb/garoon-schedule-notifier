import { ScheduleEvent } from '../api';

export interface Store {
  error?: string;

  baseURL?: string;

  refreshInMinutes: number;
  lastUpdate?: number;

  events?: ScheduleEvent[];

  notifyMinutesBefore?: number;

  playsSound?: boolean;
  soundVolume?: number;
}

export const defaultConfig: Store = {
  refreshInMinutes: 1,
  notifyMinutesBefore: 10,
  baseURL: '',
  playsSound: true,
  soundVolume: 0.6,
};

const storageKey = 'grn.config';

export function load(): Promise<Store> {
  return new Promise(resolve => {
    chrome.storage.local.get(items => {
      resolve({ ...defaultConfig, ...(items[storageKey] || {}) });
    });
  });
}

export async function save(input: Partial<Store>): Promise<void> {
  const data = await load();

  return new Promise(resolve => {
    chrome.storage.local.set({ [storageKey]: { ...data, ...input } }, resolve);
  });
}

export async function reset(): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.remove(storageKey, resolve);
  });
}
