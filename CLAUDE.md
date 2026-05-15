# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

Chrome extension (Manifest V3) that enhances schedule notifications for Garoon (Cybozu groupware). It is a **personal side project, not an official Cybozu product** — keep that framing if you touch user-visible copy. Originally forked from `kamiaka/garoon-chrome-extension` (MIT) and substantially modified.

Targets **cloud Garoon only** (`*.cybozu.com`); on-prem is unsupported. The manifest's `host_permissions` is pinned to `https://*.cybozu.com/*` — don't broaden it without a deliberate reason, and don't accept arbitrary hosts in the `baseURL` option.

## Commands

Package manager is **pnpm** (`packageManager: pnpm@10.33.0`). Toolchain is webpack + ts-loader + sass-loader; tests run on Vitest + jsdom.

```sh
pnpm install
pnpm build:dev   # one-shot development build → dist/ (runs ESLint inline; errors emit-only in dev)
pnpm build       # production build (NODE_ENV=production) + scripts/zip.sh → archive.zip; lint errors FAIL the build
pnpm start       # webpack --watch
pnpm typecheck   # tsc --noEmit -p tsconfig.test.json (covers src/ + test/)
pnpm lint        # eslint src
pnpm lint:fix    # eslint src --fix
pnpm test        # vitest run
pnpm test:watch  # vitest (watch mode)
pnpm icons       # regenerate public/icon/icon-{16,32,48,128}{,-gray}.png from src/icon/bell.svg via sharp
```

ESLint runs as part of every webpack build via `eslint-webpack-plugin` (`configType: 'flat'`, `failOnError: !isDev`). Config is `eslint.config.mjs` (flat config, ESLint 9). Two rules are active: `@typescript-eslint/no-explicit-any: error` and `prettier/prettier: error` with project-specific Prettier options inlined. Standalone `pnpm lint` is also available for CI / pre-commit use.

To load the extension locally: `pnpm build:dev`, then in `chrome://extensions` (developer mode) load `dist/` as an unpacked extension. Reload from that page after each rebuild.

## Architecture

The webpack entry points in `webpack.config.ts` map directly to MV3 surfaces (everything in `src/` is bundled into `dist/<name>.js`):

| Entry | File | Surface |
| --- | --- | --- |
| `background` | `src/background.ts` | MV3 service worker |
| `popup` | `src/popup.ts` (+ `public/popup.html`) | Toolbar popup |
| `options` | `src/options.ts` (+ `public/options.html`) | Options page (`open_in_tab`) |
| `offscreen` | `src/offscreen.ts` (+ `public/offscreen.html`) | Offscreen document for audio playback |
| `style` | `src/css/style.scss` | Shared styles, emitted as `style.css` via MiniCssExtractPlugin |

`public/` is copied verbatim into `dist/` by `CopyWebpackPlugin` (manifest, HTML, `_locales/`, generated icons).

### Single-alarm event loop

`src/background.ts` is the heart of the extension. A single `chrome.alarms` alarm (`watchNotification`, `periodInMinutes: 1`) plus `chrome.runtime.onStartup` both invoke the same `tick()` function. Each `tick()` runs **three responsibilities in order**:

1. **Conditional `update()`** — if `Date.now() - lastUpdate >= refreshInMinutes`, **or** `detectWake()` (`src/common/util/sleep.ts`) detects that the previous alarm fired more than `WAKE_THRESHOLD_MS` (75s) ago (= we likely slept), call `GaroonAPI.getScheduleEvents` and overwrite `events`. `update()` is wrapped in an inner try/catch so that API failures don't block the rest of the tick — notification judgment continues against the cached `events`.
2. **`notifyEvents()`** — for each `(event, offset)` pair, fire a notification when the half-open condition `delta = start - now`, `-GRACE_MS <= delta <= offset*60_000` holds *and* the dedup key `${event.id}:${startMs}:${offset}` is not already in `Store.notifiedKeys`. After firing, the returned merged-and-pruned key list is saved back. `GRACE_MS = 10 * 60_000`. Bursts (multiple picks in one tick) play the chime once (first pick only) but emit all notifications.
3. **`updateBadge()`** — set the action icon (color vs. gray-on-error), badge text (next event's HH:MM, or `!` on auth error), and badge color.

Between (1) and (2), the tick saves `lastAlarmPingedAt = now`. Position is deliberate: if the SW is killed mid-`update()`, the ping is **not** recorded, so the next tick sees `detectWake() == true` and force-refreshes events; if a later step throws, the ping **is** recorded, so the next tick proceeds normally rather than wasting an API call per minute.

The store keeps events from **today 00:00 through ~1 day ahead** so the popup can render already-finished events from earlier today. The 1-day upper bound matches what consumers actually need: the popup and `badge.ts nextEventToday()` only look at today, and notifications fire ≤ `MAX_NOTIFY_MINUTES` (60min) before start. Don't tighten the lower bound without checking `popup.ts setEvents()`. `mergeAndPruneNotifiedKeys` relies on this window — keys whose `${id}:${startMs}` prefix is not in `events` get dropped.

Key files for this loop: `src/common/util/eventFilter.ts` (half-open `pickEventsToNotify`, `mergeAndPruneNotifiedKeys`, `GRACE_MS`), `src/common/util/sleep.ts` (`detectWake`, `WAKE_THRESHOLD_MS`), `src/common/store/index.ts` (`notifiedKeys`, `lastAlarmPingedAt`).

### Auth-error path

API 401 surfaces through `ErrorResponse` (thrown from `src/common/api/API.ts`), caught at the top of `update()`, and routed to `requireAuth()` (`src/common/util/error.ts`). That sets a localized error string in the store, which `updateBadge()` renders as a gray icon + `!` badge, and (if `notifiesRequireAuth`) fires a click-to-open-portal notification. New error paths should funnel through `setError`/`clearError` so the badge stays in sync.

### Offscreen document for audio (MV3 constraint)

MV3 service workers cannot construct an `AudioContext`, so the chime is synthesized in a hidden offscreen document. The flow:

```
background.ts notifyEvent()
  → playChime() (src/common/util/sound.ts)
    → ensureOffscreenDocument() (creates offscreen.html lazily)
    → message.sendMessage(Type.PlaySound, volume)
      → offscreen.ts listens on Type.PlaySound and calls playChime()
```

`offscreen.ts` is a procedural FM-synthesis bell (additive partials over a 3800Hz fundamental + a short bandpass-filtered noise transient) — it does **not** load an audio asset. If you change `OFFSCREEN_PATH`, also update the manifest's `offscreen` permission/usage and `ensureOffscreenDocument()`'s URL check.

### Typed runtime-message bus

`src/common/background/index.ts` is a small wrapper around `chrome.runtime.sendMessage` / `onMessage` with two types: `Type.Update` (popup → background, "refresh now") and `Type.PlaySound` (background → offscreen). Add new cross-context calls here rather than calling `chrome.runtime` directly — listeners are registered/unregistered via the returned `UnregisterFunc`, and errors flow through `handleError`.

### Storage shape

A single key `grn.config` in `chrome.storage.local` holds the entire `Store` (see `src/common/store/index.ts`). `load()` always merges over `defaultConfig`, so adding a new field requires (a) adding it to the `Store` interface, (b) giving it a default in `defaultConfig`, and (c) wiring it into `options.ts` (read on init, write on submit).

Field migrations follow the `notifyMinutesBefore` → `notifyMinutesBeforeList` precedent: `migrateNotifyMinutes()` runs on the **raw stored value before merging `defaultConfig`** (so the default doesn't mask the absence of the new field), and `save()` keeps the deprecated scalar field in sync from the new list's head value to stay forward/backward-compatible with rolled-back versions. Mark the old field `@deprecated` in the `Store` interface rather than deleting it.

### i18n

Locale files live in `public/_locales/{en,ja}/messages.json`; `default_locale` is `ja`. HTML uses `__MSG_<key>__` placeholders, rewritten at runtime by `localizeHTML()` (`src/common/util/dom.ts`) — this string-replaces `document.body.innerHTML`, so don't put untrusted user content into the DOM before `localizeHTML()` runs. TS code reads via `t('key')` (`src/common/util/message.ts`), a thin wrapper around `chrome.i18n.getMessage` that warns on missing keys and falls back to the optional default or the key itself.

## Tests

Vitest + jsdom. Tests live colocated under `__tests__/` (e.g. `src/common/util/__tests__/badge.test.ts`); `vitest.config.ts` includes `src/**/*.test.ts` and `test/**/*.test.ts`.

- `test/setup.ts` runs before every test file. It installs a **fresh `chrome` fake** (`test/fakes/chrome.ts`) on `globalThis` per test, then `vi.restoreAllMocks()` + `vi.useRealTimers()` in `afterEach`. Don't touch the real `chrome.*` namespace from tests — extend the fake instead, and grab it via the `chromeFake()` helper.
- `test/fixtures/events.ts` provides canonical `ScheduleEvent` builders for storage/notification scenarios.
- `globals: false` — import `describe`/`it`/`expect`/`vi` explicitly from `vitest`.
- Tests compile under `tsconfig.test.json` (`target: es2020`, `module: esnext`, `moduleResolution: bundler`, `lib: ['es2020', 'dom']`), which is **distinct from `tsconfig.json` (`target: es5`, `module: commonjs`)** used for the production bundle. Code that only ever runs in tests can use modern syntax that webpack/ts-loader would still down-level for the shipped artifact, but be wary of relying on test-only DOM APIs in `src/` and assuming they're polyfilled in the bundle.
- Run a single file: `pnpm test src/common/util/__tests__/badge.test.ts`. Run by name: `pnpm test -t 'pads single digits'`.

## Conventions

- TypeScript: `target: es5`, `module: commonjs`, `strict: true`. Webpack does the bundling.
- Prettier: `singleQuote`, `printWidth: 80`, `trailingComma: all`, `tabWidth: 2`, `arrowParens: avoid`.
- `any` is forbidden by ESLint; the existing `eslint-disable-next-line @typescript-eslint/no-explicit-any` comments are concentrated in the generic runtime-message bus (`src/common/background/index.ts`) plus a couple of catch-all error handlers — keep new code typed.
- The `src/common/` barrel files (`index.ts`) re-export everything; importing from `'../common'` (or `'./common'`) is the established style rather than reaching into subpaths.
