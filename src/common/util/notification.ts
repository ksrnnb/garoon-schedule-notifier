import { icons } from '../constants';

type NotificationID = string;

// ID は uniqueness のためだけに使う。SW restart で counter は Date.now() に
// 戻るが、Date.now() は単調増加なので前世代との衝突は実質起きない。
// 呼び出し側が deterministic な ID を渡す場合はそちらを優先する (= 同じ
// (event, offset) ペアが何かの拍子で 2 回 fire しても、chrome.notifications
// 側が「同 ID は既存を clear してから create」する仕様で実質 1 件に収まる)。
let notificationCounter = Date.now();

// クリック時の遷移先 URL は chrome.storage.session に保存する。
// 関数ハンドラを in-memory に持つ素朴な実装だと:
//   (a) SW が落ちて再起動した直後、過去の通知をクリックしてもハンドラが
//       消えていて何も起きない (主要なバグ)
//   (b) ハンドラ配列がクリアされず線形にリークする
// session storage はブラウザセッション中だけ保持され、SW restart を跨ぐ。
const URL_KEY_PREFIX = 'grn.notify_url:';

function urlKey(id: NotificationID): string {
  return URL_KEY_PREFIX + id;
}

function onShowNotificationSettings() {
  chrome.tabs.create({
    url: '/options.html',
  });
}

async function onClickedNotification(id: NotificationID) {
  try {
    const key = urlKey(id);
    const items = await chrome.storage.session.get(key);
    const url = items[key] as string | undefined;
    if (url) {
      chrome.tabs.create({ url });
    }
    await chrome.storage.session.remove(key);
  } finally {
    chrome.notifications.clear(id);
  }
}

export function initNotificationEvent() {
  chrome.notifications.onClicked.addListener(onClickedNotification);
  chrome.notifications.onShowSettings.addListener(onShowNotificationSettings);
}

export async function notify(
  options: chrome.notifications.NotificationOptions,
  onClickUrl?: string,
  notificationId?: string,
): Promise<NotificationID> {
  const id = notificationId ?? `grn-notification-${++notificationCounter}`;
  if (onClickUrl) {
    await chrome.storage.session.set({ [urlKey(id)]: onClickUrl });
  }
  return new Promise(resolve => {
    chrome.notifications.create(
      id,
      {
        type: 'basic',
        iconUrl: icons.Logo[128],
        title: '',
        message: '',
        ...options,
      },
      created => resolve(created),
    );
  });
}
