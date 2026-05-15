export function t(key: string, substitutions?: string | string[]): string {
  const msg = chrome.i18n.getMessage(key, substitutions);
  if (!msg) {
    console.warn(`undefined message key: ${key}`);
  }
  return msg || key;
}
