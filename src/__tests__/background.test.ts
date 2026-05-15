/**
 * background.ts の tick() 統合テスト。
 *
 * background.ts は import 時に run() を呼び chrome.* リスナーを登録するため、
 * 各 test で chrome fake を install → vi.resetModules() → 動的 import の順で
 * 新鮮な module ロードを行う。GaroonAPI / 重い util は vi.mock で差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEvent } from '../../test/fixtures/events';
import { WAKE_THRESHOLD_MS } from '../common/util/sleep';

const STORAGE_KEY = 'grn.config';

const getScheduleEventsMock = vi.fn();

// GaroonAPI を network 呼び出しせずに mock。ErrorResponse は 401 path を
// 踏ませるために実物相当の最小実装を提供する。
vi.mock('../common/api', () => {
  class GaroonAPI {
    constructor(public _baseURL: string) {}
    getScheduleEvents = getScheduleEventsMock;
  }
  class ErrorResponse extends Error {
    constructor(private _status: number) {
      super('mock ErrorResponse');
    }
    status(): number {
      return this._status;
    }
  }
  return { GaroonAPI, ErrorResponse };
});

// background.ts は ../common から純粋関数 + 副作用ヘルパを importする。
// 純粋関数 (filterUpcomingEvents / pickEventsToNotify / mergeAndPruneNotifiedKeys
// / detectWake) は実物を残し、副作用持ち (notify / playChime / updateBadge /
// requireAuth / setError / clearError / initNotificationEvent) と i18n 系のみ
// 差し替える。
const notifyMock = vi.fn();
const playChimeMock = vi.fn().mockResolvedValue(undefined);
const updateBadgeMock = vi.fn().mockResolvedValue(undefined);
const requireAuthMock = vi.fn().mockResolvedValue(undefined);
const setErrorMock = vi.fn().mockResolvedValue(undefined);
const clearErrorMock = vi.fn().mockResolvedValue(undefined);
const initNotificationEventMock = vi.fn();

vi.mock('../common', async () => {
  const actual = await vi.importActual<typeof import('../common')>('../common');
  return {
    ...actual,
    notify: notifyMock,
    playChime: playChimeMock,
    updateBadge: updateBadgeMock,
    requireAuth: requireAuthMock,
    setError: setErrorMock,
    clearError: clearErrorMock,
    initNotificationEvent: initNotificationEventMock,
    t: (key: string) => key,
    timeString: (d: Date) => d.toISOString(),
  };
});

type ChromeListener<Args extends unknown[] = unknown[]> = (
  ...args: Args
) => unknown;

interface ChromeListenerSlot<Args extends unknown[] = unknown[]> {
  fn?: ChromeListener<Args>;
}

function installChrome(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { ...initial };
  const alarmSlot: ChromeListenerSlot = {};
  const startupSlot: ChromeListenerSlot = {};
  const installedSlot: ChromeListenerSlot = {};
  const saveSpy = vi.fn();

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get(cb: (items: Record<string, unknown>) => void) {
          cb({ ...state });
        },
        set(items: Record<string, unknown>, cb?: () => void) {
          Object.assign(state, items);
          saveSpy(items);
          cb?.();
        },
        remove(key: string, cb?: () => void) {
          delete state[key];
          cb?.();
        },
      },
    },
    alarms: {
      onAlarm: {
        addListener(fn: ChromeListener) {
          alarmSlot.fn = fn;
        },
      },
      create: vi.fn(),
    },
    runtime: {
      onInstalled: {
        addListener(fn: ChromeListener) {
          installedSlot.fn = fn;
        },
      },
      onStartup: {
        addListener(fn: ChromeListener) {
          startupSlot.fn = fn;
        },
      },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    notifications: {
      onClicked: { addListener: vi.fn() },
      onShowSettings: { addListener: vi.fn() },
      create: vi.fn(),
      clear: vi.fn(),
    },
    action: {
      setIcon: vi.fn(),
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    tabs: { create: vi.fn() },
  });

  return { state, alarmSlot, startupSlot, installedSlot, saveSpy };
}

async function loadBackground(): Promise<typeof import('../background')> {
  vi.resetModules();
  return await import('../background');
}

// store fixture: STORAGE_KEY 配下に Store を流し込む helper
function seedStore(
  state: Record<string, unknown>,
  partial: Record<string, unknown>,
) {
  state[STORAGE_KEY] = {
    baseURL: 'https://example.cybozu.com/g/',
    refreshInMinutes: 1,
    notifyMinutesBefore: 10,
    notifyMinutesBeforeList: [10],
    playsSound: true,
    soundVolume: 0.6,
    notifiedKeys: [],
    ...partial,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  getScheduleEventsMock.mockReset();
  getScheduleEventsMock.mockResolvedValue({ events: [] });
  notifyMock.mockReset();
  playChimeMock.mockReset();
  playChimeMock.mockResolvedValue(undefined);
  updateBadgeMock.mockReset();
  updateBadgeMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(undefined);
  setErrorMock.mockReset();
  setErrorMock.mockResolvedValue(undefined);
  clearErrorMock.mockReset();
  clearErrorMock.mockResolvedValue(undefined);
  initNotificationEventMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('background module load', () => {
  it('does not call update() (== GaroonAPI.getScheduleEvents) on module load', async () => {
    installChrome();
    await loadBackground();
    expect(getScheduleEventsMock).not.toHaveBeenCalled();
  });

  it('registers alarm + onStartup listeners', async () => {
    const { alarmSlot, startupSlot } = installChrome();
    await loadBackground();
    expect(alarmSlot.fn).toBeTypeOf('function');
    expect(startupSlot.fn).toBeTypeOf('function');
  });
});

describe('tick()', () => {
  it('skips update() when refreshInMinutes gate not satisfied and not waking', async () => {
    const ctx = installChrome();
    const now = Date.now();
    seedStore(ctx.state, {
      refreshInMinutes: 1000,
      lastUpdate: now, // 直近で更新済み
      lastAlarmPingedAt: now - 30_000, // スリープ復帰でもない
    });
    const bg = await loadBackground();
    await bg.tick();
    expect(getScheduleEventsMock).not.toHaveBeenCalled();
  });

  it('forces update() when detectWake fires regardless of refreshInMinutes gate', async () => {
    const ctx = installChrome();
    const now = Date.now();
    seedStore(ctx.state, {
      refreshInMinutes: 1000,
      lastUpdate: now,
      lastAlarmPingedAt: now - WAKE_THRESHOLD_MS - 60_000,
    });
    const bg = await loadBackground();
    await bg.tick();
    expect(getScheduleEventsMock).toHaveBeenCalledTimes(1);
  });

  it('runs notifyEvents() + updateBadge() even when update() throws', async () => {
    const ctx = installChrome();
    seedStore(ctx.state, {});
    getScheduleEventsMock.mockRejectedValue(new Error('network down'));
    const bg = await loadBackground();
    await bg.tick();
    expect(updateBadgeMock).toHaveBeenCalledTimes(1);
  });

  it('saves lastAlarmPingedAt after update() and before notifyEvents()', async () => {
    const ctx = installChrome();
    const now = Date.now();
    seedStore(ctx.state, {
      refreshInMinutes: 1,
      lastUpdate: 0, // gate 通過 → update が走る
    });
    const bg = await loadBackground();
    await bg.tick();

    // saveSpy は chrome.storage.local.set への引数を記録している。
    // 各 set 呼び出しは { [STORAGE_KEY]: merged Store } の形なので、
    // STORAGE_KEY を取り出した snapshot 列で順序を判定する。
    const snaps = ctx.saveSpy.mock.calls.map(
      c =>
        (c[0] as Record<string, unknown>)[STORAGE_KEY] as Record<
          string,
          unknown
        >,
    );
    // update() が events → lastUpdate を save し、tick() がその後 lastAlarmPingedAt を save する
    const lastUpdateIdx = snaps.findIndex(
      s => typeof s.lastUpdate === 'number' && s.lastUpdate > 0,
    );
    const pingIdx = snaps.findIndex(
      s => typeof s.lastAlarmPingedAt === 'number',
    );
    expect(lastUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeGreaterThan(lastUpdateIdx);
    expect(snaps[pingIdx].lastAlarmPingedAt).toBeGreaterThanOrEqual(now);
  });

  it('still saves lastAlarmPingedAt when update() inner catch is taken', async () => {
    const ctx = installChrome();
    seedStore(ctx.state, {});
    getScheduleEventsMock.mockRejectedValue(new Error('boom'));
    const bg = await loadBackground();
    await bg.tick();
    const snaps = ctx.saveSpy.mock.calls.map(
      c =>
        (c[0] as Record<string, unknown>)[STORAGE_KEY] as Record<
          string,
          unknown
        >,
    );
    expect(snaps.some(s => typeof s.lastAlarmPingedAt === 'number')).toBe(true);
  });

  it('does not save notifiedKeys when notifyEvents() returns undefined (no picks, no prune)', async () => {
    const ctx = installChrome();
    seedStore(ctx.state, {
      events: [], // pick=0, prune 差分なし
      notifiedKeys: [],
    });
    const bg = await loadBackground();
    await bg.tick();
    const snaps = ctx.saveSpy.mock.calls.map(
      c =>
        (c[0] as Record<string, unknown>)[STORAGE_KEY] as Record<
          string,
          unknown
        >,
    );
    // どの snapshot でも notifiedKeys は [] のまま (新規キーが書き込まれていない)
    expect(
      snaps.every(
        s =>
          Array.isArray(s.notifiedKeys) &&
          (s.notifiedKeys as unknown[]).length === 0,
      ),
    ).toBe(true);
  });

  it('saves notifiedKeys when picks fire', async () => {
    const ctx = installChrome();
    const now = Date.now();
    const start = new Date(now + 10 * 60_000);
    const ev = buildEvent({ id: 'fire', start });
    seedStore(ctx.state, {
      events: [ev],
      notifyMinutesBeforeList: [10],
      notifiedKeys: [],
      refreshInMinutes: 1000, // update をスキップして notify のみ走らせる
      lastUpdate: now,
      lastAlarmPingedAt: now - 30_000,
    });
    const bg = await loadBackground();
    await bg.tick();
    const snaps = ctx.saveSpy.mock.calls.map(
      c =>
        (c[0] as Record<string, unknown>)[STORAGE_KEY] as Record<
          string,
          unknown
        >,
    );
    const expectedKey = `fire:${start.getTime()}:10`;
    expect(
      snaps.some(
        s =>
          Array.isArray(s.notifiedKeys) &&
          (s.notifiedKeys as unknown[]).length === 1 &&
          (s.notifiedKeys as string[])[0] === expectedKey,
      ),
    ).toBe(true);
  });

  it('plays chime only for the first event when multiple notifications fire in one tick', async () => {
    const ctx = installChrome();
    const now = Date.now();
    const start = new Date(now + 10 * 60_000);
    const a = buildEvent({ id: 'a', start });
    const b = buildEvent({ id: 'b', start });
    seedStore(ctx.state, {
      events: [a, b],
      notifyMinutesBeforeList: [10],
      notifiedKeys: [],
      playsSound: true,
      soundVolume: 0.6,
      refreshInMinutes: 1000,
      lastUpdate: now,
      lastAlarmPingedAt: now - 30_000,
    });
    const bg = await loadBackground();
    await bg.tick();

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(playChimeMock).toHaveBeenCalledTimes(1);
    expect(playChimeMock).toHaveBeenCalledWith(0.6);
  });

  it('onStartup listener triggers tick() (= calls updateBadge)', async () => {
    const ctx = installChrome();
    seedStore(ctx.state, {});
    const { startupSlot } = ctx;
    await loadBackground();
    expect(startupSlot.fn).toBeTypeOf('function');
    await startupSlot.fn!();
    expect(updateBadgeMock).toHaveBeenCalled();
  });
});
