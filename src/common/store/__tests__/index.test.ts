import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load, save } from '../index';

const STORAGE_KEY = 'grn.config';

type LocalArea = {
  get: (cb: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, cb?: () => void) => void;
  remove: (key: string, cb?: () => void) => void;
};

function installChromeStorageFake(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { ...initial };
  const local: LocalArea = {
    get(cb) {
      cb({ ...state });
    },
    set(items, cb) {
      Object.assign(state, items);
      cb?.();
    },
    remove(key, cb) {
      delete state[key];
      cb?.();
    },
  };
  vi.stubGlobal('chrome', { storage: { local } });
  return state;
}

describe('store.load migration', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns defaults when nothing is stored', async () => {
    installChromeStorageFake();
    const s = await load();
    expect(s.notifyMinutesBeforeList).toEqual([10]);
    expect(s.notifyMinutesBefore).toBe(10);
  });

  it('migrates legacy notifyMinutesBefore to notifyMinutesBeforeList', async () => {
    const state = installChromeStorageFake({
      [STORAGE_KEY]: {
        baseURL: 'https://example.cybozu.com/g/',
        notifyMinutesBefore: 15,
        refreshInMinutes: 1,
      },
    });

    const s = await load();
    expect(s.notifyMinutesBeforeList).toEqual([15]);
    expect(s.notifyMinutesBefore).toBe(15);

    // 書き戻されている
    const written = state[STORAGE_KEY] as {
      notifyMinutesBeforeList?: number[];
    };
    expect(written.notifyMinutesBeforeList).toEqual([15]);
  });

  it('does not overwrite an existing notifyMinutesBeforeList', async () => {
    const state = installChromeStorageFake({
      [STORAGE_KEY]: {
        notifyMinutesBefore: 5,
        notifyMinutesBeforeList: [15, 3, 1],
        refreshInMinutes: 1,
      },
    });

    const s = await load();
    expect(s.notifyMinutesBeforeList).toEqual([15, 3, 1]);
    // 旧フィールドはそのまま残し、load では同期しない (sync は save の責務)
    expect(s.notifyMinutesBefore).toBe(5);

    // 不要な書き戻しが発生していない (state は触らない実装)
    const written = state[STORAGE_KEY] as { notifyMinutesBefore?: number };
    expect(written.notifyMinutesBefore).toBe(5);
  });

  it('treats an empty array as missing and migrates from legacy', async () => {
    installChromeStorageFake({
      [STORAGE_KEY]: {
        notifyMinutesBefore: 7,
        notifyMinutesBeforeList: [],
        refreshInMinutes: 1,
      },
    });

    const s = await load();
    expect(s.notifyMinutesBeforeList).toEqual([7]);
  });
});

describe('store.save syncing legacy field', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates legacy notifyMinutesBefore to the head of the new list', async () => {
    const state = installChromeStorageFake({
      [STORAGE_KEY]: {
        notifyMinutesBefore: 10,
        notifyMinutesBeforeList: [10],
        refreshInMinutes: 1,
      },
    });

    await save({ notifyMinutesBeforeList: [15, 3, 1] });

    const written = state[STORAGE_KEY] as {
      notifyMinutesBefore?: number;
      notifyMinutesBeforeList?: number[];
    };
    expect(written.notifyMinutesBeforeList).toEqual([15, 3, 1]);
    expect(written.notifyMinutesBefore).toBe(15);
  });

  it('leaves legacy field untouched when notifyMinutesBeforeList is not in input', async () => {
    const state = installChromeStorageFake({
      [STORAGE_KEY]: {
        notifyMinutesBefore: 8,
        notifyMinutesBeforeList: [8, 2],
        refreshInMinutes: 1,
      },
    });

    await save({ baseURL: 'https://example.cybozu.com/g/' });

    const written = state[STORAGE_KEY] as {
      baseURL?: string;
      notifyMinutesBefore?: number;
      notifyMinutesBeforeList?: number[];
    };
    expect(written.baseURL).toBe('https://example.cybozu.com/g/');
    expect(written.notifyMinutesBefore).toBe(8);
    expect(written.notifyMinutesBeforeList).toEqual([8, 2]);
  });
});
