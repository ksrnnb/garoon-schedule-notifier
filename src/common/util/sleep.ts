// chrome.alarms は通常 1 分間隔で発火する。実際の発火には数秒のブレがあるため
// バッファを足し、その閾値を超える間隔が空いていればスリープ復帰とみなす。
const PING_INTERVAL_MS = 60_000;
const PING_BUFFER_MS = 15_000;
export const WAKE_THRESHOLD_MS = PING_INTERVAL_MS + PING_BUFFER_MS;

// 前回 alarm 発火からの経過時間で「スリープしていた」を判定する。
// lastAlarmPingedAt が未設定 (初回) は復帰判定しない。
//
// MV3 SW は ~30s で終了するため in-memory state を持てない。判定に必要な
// 状態は Store.lastAlarmPingedAt 経由で永続化する想定。
export function detectWake(
  now: number,
  lastAlarmPingedAt: number | undefined,
): boolean {
  if (lastAlarmPingedAt == null) return false;
  return now - lastAlarmPingedAt > WAKE_THRESHOLD_MS;
}
