import { ScheduleEvent } from '../api';

export interface Store {
  error?: string;

  baseURL?: string;

  refreshInMinutes: number;
  lastUpdate?: number;

  events?: ScheduleEvent[];

  /**
   * @deprecated notifyMinutesBeforeList に統合。後方互換 (旧バージョンへの
   * ロールバック耐性) のため温存し、save() 時に先頭値で同期する。
   */
  notifyMinutesBefore?: number;
  notifyMinutesBeforeList?: number[];

  playsSound?: boolean;
  soundVolume?: number;

  /** 通知済みキー (`${event.id}:${startMs}:${offset}`)。1 予定 × 1 オフセットにつき 1 度だけ通知するための dedup 用。 */
  notifiedKeys?: string[];
  /** 直近の watchNotification alarm 発火時刻 (ms)。スリープ復帰検知用 (detectWake)。未発火 = undefined。 */
  lastAlarmPingedAt?: number;
}

export const defaultConfig: Store = {
  refreshInMinutes: 1,
  notifyMinutesBefore: 10,
  notifyMinutesBeforeList: [10],
  baseURL: '',
  playsSound: true,
  soundVolume: 0.6,
  notifiedKeys: [],
};

const storageKey = 'grn.config';

export function load(): Promise<Store> {
  return new Promise(resolve => {
    chrome.storage.local.get(items => {
      const stored: Partial<Store> = items[storageKey] || {};
      const { stored: migratedStored, changed } = migrateNotifyMinutes(stored);
      const final: Store = { ...defaultConfig, ...migratedStored };
      if (changed) {
        chrome.storage.local.set({ [storageKey]: migratedStored }, () =>
          resolve(final),
        );
        return;
      }
      resolve(final);
    });
  });
}

export async function save(input: Partial<Store>): Promise<void> {
  const data = await load();
  const next: Store = { ...data, ...input };

  // 新フィールドが更新されたら旧フィールドも先頭値で同期する。
  // 旧バージョンへロールバックされた場合に、ユーザーが最初に入力した
  // タイミングが残る (1個しか通知できない世界での既定値として扱う)。
  if (
    input.notifyMinutesBeforeList &&
    input.notifyMinutesBeforeList.length > 0
  ) {
    next.notifyMinutesBefore = input.notifyMinutesBeforeList[0];
  }

  return new Promise(resolve => {
    chrome.storage.local.set({ [storageKey]: next }, resolve);
  });
}

export async function reset(): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.remove(storageKey, resolve);
  });
}

// 旧フィールド notifyMinutesBefore のみを持つ旧ユーザー向けの一回限りの
// マイグレーション。新フィールドが既にあれば触らない。デフォルトとマージ
// される前の生のストレージ値に対して実行する必要がある (そうしないと
// defaultConfig.notifyMinutesBeforeList が常に被ってしまう)。
function migrateNotifyMinutes(s: Partial<Store>): {
  stored: Partial<Store>;
  changed: boolean;
} {
  if (s.notifyMinutesBeforeList && s.notifyMinutesBeforeList.length > 0) {
    return { stored: s, changed: false };
  }
  if (typeof s.notifyMinutesBefore === 'number') {
    return {
      stored: { ...s, notifyMinutesBeforeList: [s.notifyMinutesBefore] },
      changed: true,
    };
  }
  return { stored: s, changed: false };
}
