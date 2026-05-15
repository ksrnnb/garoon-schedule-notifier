import { ErrorResponse } from '../api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isFetchError(err: any): err is Error {
  return (
    err instanceof Error &&
    err.name === 'TypeError' &&
    err.message === 'Failed to fetch'
  );
}
import * as store from '../store';
import { updateBadge } from './badge';
import { t } from './message';
import { notify } from './notification';

export async function requireAuth(inAction?: boolean) {
  const { error, baseURL } = await store.load();
  const msg = t('err_unauthenticated');

  await setError(msg);

  if (!inAction && error !== msg) {
    await notify({ title: msg }, baseURL);
  }
}

export async function setError(error?: string) {
  await store.save({ error, lastUpdate: Date.now() });

  updateBadge();
}

export async function clearError() {
  await setError(undefined);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleError(err: any, inAction?: boolean) {
  if (isFetchError(err)) {
    await setError(t('failed_to_fetch'));
    return;
  }

  if (err instanceof ErrorResponse) {
    if (err.status() === 401) {
      await requireAuth(inAction);
      return;
    }

    const msg = await err.message();
    console.warn(`API Error status ${err.status()}`, msg ?? '');
    return;
  }
  // 既知の error type 以外は contract 上「best-effort で握る」設計
  // (caller の bus は sendResponse({ error }) で別途伝搬する)。
  // 過去版で書かれていた `Promise.reject(err)` は浮いた rejection を
  // 作るだけで何の効果も無かったため、診断ログに置換した。
  console.warn('unhandled error in handleError', err);
}
