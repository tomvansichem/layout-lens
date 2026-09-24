# CLAUDE.md — Layout Lens

Working notes for developing this extension. Read alongside `README.md` (user-facing).

## What it is

MV3 extension for Chrome and Firefox (see "Firefox" below). A hover
inspector for padding/margin + a **CSS-size vs rendered-size discrepancy**
checker. Shortcut-activated only — the toolbar
popup is static help text, nothing more; no options page, no settings.

## Hard constraints (don't regress these)

- **No build step.** Plain JS, loadable via "Load unpacked". No bundler, no deps.
- **No persistent state on disk.** `chrome.storage.session` is the one
  exception (see below) — it's memory-only, cleared when the browser closes,
  and never touches `storage.local`/`sync`. Nothing else persists.
- **Minimal permissions.** `activeTab` + `storage` (for `storage.session`
  only). No host permissions, no `tabs`, no `scripting`. `activeTab` is
  granted on command execution, which is what lets the worker `sendMessage`
  the content scripts.
- **The popup is static help only.** Shortcut list + the rebind link, no
  script, no options, no state. Don't add logic to it without revisiting this
  section — the moment it does something, it's a different kind of extension.
- **`pointer-events: none`** on every overlay node — the page must stay fully
  interactive while active.
- **Zero trace on deactivate** — every listener removed, overlay DOM gone.
- Must work identically on live sites, `localhost`, and `file://`
  (`file://` also needs the user's "Allow access to file URLs" toggle).

## Architecture

Four files do the work: `manifest.json`, `background.js`, `content.js`,
`overlay.css`. `popup.html` is static help text with no logic — it doesn't
participate in this flow at all.

```
Alt+S  ──> chrome.commands.onCommand (background.js)
             │  flips storage.session[tabId]
             ▼
       broadcast: chrome.tabs.sendMessage(tabId, {type:"LAYOUT_LENS_SET", active})
             │  (no frameId => every frame)
             ▼
       content.js onMessage ──> activate() / deactivate()   [idempotent]

Esc (content.js) ──> deactivate() locally
                 └─> chrome.runtime.sendMessage({type:"LAYOUT_LENS_ESC"})
                       ▼
                 background: storage.session[tabId]=false + broadcast(false)
```

`Alt+U` takes the same worker→frames path with `{type:"LAYOUT_LENS_CYCLE_UNIT"}`.
It's display-only, so the worker just forwards it — no state at all, not even
in storage.session.

**The worker is the single source of truth for on/off state.** Content scripts
never flip their own state independently — that's what keeps multi-frame pages
in sync (one `Alt+S` = whole tab, `Esc` anywhere = whole tab off).
State lives in `chrome.storage.session` (one boolean per tabId, absent = off),
not a worker-local variable — a plain in-memory `Map` didn't survive MV3
service-worker eviction (an idle worker can be killed and restarted at any
time), which cost users a dead first keypress after a resync. `storage.session`
is memory-only and cleared when the browser closes, so this doesn't reopen the
"no persistent state" constraint, just narrows what it means. Still cleared on
tab close and on `status === "loading"`.

### content.js internals

- IIFE with `window.__LAYOUT_LENS_ACTIVE_INSTANCE__` guard — per frame (each
  frame has its own `window`).
- **Overlay nodes:** one `#layout-lens-root` (`position:fixed; inset:0;
  pointer-events:none; z-index:2147483647; contain:strict`) holding
  `marginBox`, `paddingBox`, `outline` (border-drawn rings — the per-side
  border-width *is* the margin/padding value), `labelLayer` (per-side px
  labels), `tip` (cursor-following info box).
- **rAF loop (`frame`)** runs *only while an element is tracked*. Re-reads
  `getBoundingClientRect()` every frame (scroll/resize/animation tracking);
  `getComputedStyle` is cached in `metrics` and only refreshed on target change.
  Goes idle (`rafId = 0`) when nothing is hovered; `ensureLoop()` restarts it
  from `applyTarget()`.
- **Targeting:** `mouseover` + `mousemove` (with `elementFromPoint` fallback for
  pages that stop `mouseover` propagation) → `setTarget` → `applyTarget`.
- **Keyboard tree nav:** `lockedEl` (current keyboard selection) + `originEl`
  (deepest element the descent started from). `↑` = parent, `↓` = retrace
  toward `originEl`, one press past origin releases. Moving the mouse clear of
  `originEl` releases. While locked, mouse targeting is suppressed.
- **Pin (`f`):** `frozen` flag (internal name unchanged; user-facing copy says
  "pin", not "freeze" — see Gotchas). `onMouseOver`/`onMouseMove`/`setTarget`
  all bail while set, so mouse *targeting* stops, but the rAF loop keeps
  re-reading the pinned element's rect every frame — it still tracks scroll,
  resize, and layout animation. That's what makes pin-then-scroll-to-compare
  work. `↑`/`↓`/`c` still work. Unfreeze retargets under the cursor. Cleared
  on `hideBoxes`/`deactivate`.
- **Copy (`c`):** `renderTip` rebuilds `lastReport` every frame from the lines
  it marks `report:true` (selector, sizes, warnings — not the breadcrumb/hint).
  `copyText` uses `navigator.clipboard` with an `execCommand` fallback for
  non-secure contexts. `copiedAt` drives a 900ms `✓ copied` line; the running
  rAF loop clears it. Both keys are guarded against editable `e.target` and
  against `ctrl`/`meta`/`alt` (never shadow Ctrl/Cmd+C).
- **Transform cause:** `readMetrics` sets `m.xform` — `"transform on this
  element"` or `ancestor <sel> is transformed` (walks `parentElement` calling
  `getComputedStyle`). Shown as a `↳` line only inside the mismatch block.
- **Unit toggle (`Alt+U`):** `unit` cycles `px`→`rem`→`em` (module `let`, back
  to `px` on `deactivate` — no storage). Display-only: measuring stays in px,
  `fmtLen()` converts at render time. `unitScale` is recomputed each frame in
  `render()` — `rem` divides by a fresh `getComputedStyle(documentElement)
  .fontSize`, `em` by the target's cached `m.fontPx`; `|| 16` is just a floor
  for an unparseable value. Feeds the padding/margin labels, the `CSS…|Visual…`
  line, and the variance/`fmtDelta` lines (not the clip line). `.ll-unit` is a
  ~1s opacity-fade toast — the only CSS transition in `overlay.css`.
- **Size-mismatch check (red):** `readMetrics` normalizes
  `getComputedStyle().width/height` to a **border-box** figure (adds
  padding+border when box-sizing is content-box) so ordinary padded elements are
  NOT flagged. Threshold `> 0.5px`. The only reliable trigger is a CSS
  `transform` on the element or an ancestor (rect is post-transform, computed
  width isn't). `min`/`max` clamping, `flex-shrink`, and `zoom` on Chrome 128+
  do **not** trigger it — computed style already returns the used value.
- **Clip check (amber):** per axis, when `overflowX`/`overflowY` is `hidden` or
  `clip` (cached as `m.ovX`/`m.ovY`) and `scrollWidth - clientWidth >= 1`
  (read live each frame). `scroll`/`auto` are excluded — content is reachable.
  SVG elements lack `scrollWidth`/`clientWidth`; `NaN >= 1` is false, so they're
  safe without a guard. Precedence in `render()`: red mismatch > amber clip >
  purple keyboard-lock; only one state class is set on the outline at a time,
  but the tooltip shows clip lines even under a red mismatch.
- **Clamp line (info, not a warning):** `readMetrics`' `clampAxis` compares raw
  `cs.width`/`cs.height` against `cs.minWidth`/`cs.maxWidth`/`cs.minHeight`/
  `cs.maxHeight`; a match within 0.5px means that axis is `min`/`max`-pinned
  rather than sized by `width`/`height`/intrinsic sizing. `parseFloat("auto")`
  and `parseFloat("none")` are both `NaN`, so an unset bound is naturally
  excluded — no extra branching needed. Cached in `m.clampW`/`m.clampH` on
  target change, rendered as a `↳` line independent of `mismatch` (that's the
  whole point — this is precisely the case the size-mismatch check can't see,
  because clamping resolves before computed style is read).
- **Viewport-overflow line (info, not a warning):** in `render()`,
  `R.right + window.scrollX - document.documentElement.clientWidth`. Computed
  live (not cached) because scroll position changes every frame. A different
  question from the clip check — that one is the element's *content* vs its
  own box; this is the element's own *box* vs the page. No outline-color
  change, tooltip line only, reuses `.ll-clipwarn`'s amber text.

## Firefox

One codebase, one manifest, one zip for both stores. Firefox MV3 has no
service workers, so `background` lists `background.js` twice: Chrome reads
`service_worker`, Firefox reads `scripts` and runs it as an event page. Chrome
before 121 refused a manifest with both keys, hence `minimum_chrome_version:
121`; Firefox 121+ likewise starts the event page despite `service_worker`.

- `browser_specific_settings.gecko.id` is the AMO identity. **Never change it
  after the first AMO upload**; a new ID is a new add-on.
- `data_collection_permissions: none` is required for new AMO listings since
  Nov 2025, and supported from Firefox 140, hence `strict_min_version: 140.0`.
- No code differences: Firefox accepts `chrome.*` (callbacks and promises),
  has `storage.session`, and grants `activeTab` on a `commands` shortcut.
- Content-script host access comes from the install prompt (Firefox 127+),
  but the user can revoke it per site. Revoked = no content script = the
  shortcut silently does nothing on that site, same as `chrome://` pages.
- `test/smoke.mjs` is Chrome-only (CDP). Firefox is covered by the manual
  checklist.

## Gotchas already hit (do not reintroduce)

1. **`!important` in `overlay.css` for `left`/`top`/`width`/`height` breaks
   positioning.** Those are set as inline styles from JS every frame, and a
   stylesheet `!important` beats inline styles, clamping everything to (0,0).
   Keep position/size declarations out of the stylesheet, or non-`!important`.
   (`.ll-label` was fine only because it never declared top/left.)
2. **`preventDefault()` on arrow keys is not enough to stop scrolling.** Sites
   with smooth-scroll libs (Lenis, Locomotive, GSAP ScrollSmoother) scroll from
   their *own* `keydown` handler. Fix in place: listen on `window` in the
   **capture phase** and `stopImmediatePropagation()` for `ArrowUp`/`ArrowDown`
   — but only when something is hovered, so the page scrolls normally otherwise.
3. **`background.js` messaging needs no host permission** because `activeTab` is
   granted by the command invocation. Don't add host permissions to "fix"
   messaging.
4. **"Freeze" → "pin" was a copy-only change.** The `f` key's user-facing text
   (hint line, `PINNED` tag) says "pin"; the internal identifiers (`frozen`,
   `toggleFreeze`) still say freeze. Don't rename the internals to match —
   it's a large diff for zero behavior change. If you touch this code, expect
   the mismatch and don't "fix" it mid-unrelated-change.
5. **Stable-channel Chrome silently ignores `--load-extension`.** Confirmed on
   Chrome 152: no error, the extension just never registers — verified with a
   trivial, unrelated MV3 extension, so it's not specific to this repo. Only
   matters for `test/harness.mjs`; doesn't affect real usage (users load via
   "Load unpacked" through the UI, which is unaffected). A "Chrome for Testing"
   build doesn't have the restriction — see the comment at the top of
   `test/harness.mjs`.
6. **Not every Chrome for Testing build actually works either.** 152.0.7977.82
   passes the full smoke test; 153.0.8010.36 loads the extension (manifest
   readable, service worker starts) but never injects the content script into
   any page — a Chrome-side issue, not a Layout Lens one, but it means "latest
   Chrome for Testing" is not a safe default. Pin a version you've actually
   verified (`node test/smoke.mjs` going green), especially in CI.

## Regenerating icons

```
node tools/gen-icons.js
```

Dependency-free (Node `zlib` only). Art = the tool's own language: dark rounded
tile, orange margin ring → green padding ring → light content square. Colors
match `overlay.css` (`#f6b26b`, `#87c882`).

## Regenerating the Store promo tile

```
node tools/gen-promo-tile.mjs
```

Rasterizes `assets/promo/small-tile.svg` (hand-made, edited directly, not
generated) to exactly 440×280 (the Store's "Small tile" slot — shown in
category/search browsing in place of an uploaded icon, which is what was
happening before this existed). Reuses `test/harness.mjs`'s Chrome launcher
and CDP client, so it needs the same Chrome-for-Testing-or-real-Chrome setup
as `test/smoke.mjs` (`CHROME_PATH`, see that file's header) — no extension is
loaded here, so plain stable Chrome works fine too, unlike the smoke test. The
SVG is inlined into a wrapper page at capture time rather than opened via
`file://` directly, so there's no intermediate file that can fall out of sync
with it.

To change the tile, edit `small-tile.svg` itself, then rerun the command.
Output is `assets/promo/small-tile.png` — a publishing artifact like
`assets/screenshots/`, not part of the extension package. Uploading it to the
Dashboard is a manual step (see `TODO.md`'s Task 5 history for why that's
user-only).

## Manual test checklist

- Live site with a smooth-scroll lib (agency/portfolio site): `Alt+S`, hover,
  overlays land on the right elements; `↑`/`↓` navigate and do **not** scroll
  the page; wheel still scrolls; `Esc` leaves no trace.
- `localhost` app and a local `.html` opened as `file://` (with file-URL access
  enabled): same behavior.
- Page with a same-origin `<iframe>`: `Alt+S` toggles both; hovering inside the
  iframe measures inner elements.
- Element with `transform: scale(...)`: dashed red outline + variance line.
- Element with only padding: **no** mismatch UI.
- `overflow:hidden` box with a too-wide child, and a `text-overflow:ellipsis`
  label: dashed **amber** outline + `content … clipped to …` line.
- `overflow:hidden` with content that fits, and an `overflow:auto` scroll box:
  **no** clip UI.
- DevTools open, resize viewport: overlay tracks.
- `Alt+U` cycles `px`→`rem`→`em`→`px`: every label, the `CSS…|Visual…` line and
  the variance line switch unit; `Unit: …` flashes ~1s. Override `<html>`
  `font-size` → `rem` tracks it. On an element with its own `font-size`, `em`
  differs from `rem`. `Esc` / `Alt+S`-off returns to `px`.
- Element with `width` pinned by `min-width`/`max-width`: `↳ width pinned by
  min-width (…), not width` line, no red outline. Element wider than the
  viewport (e.g. a fixed px width past the page's max-width): `↔ …px wider
  than the viewport` line, no outline change.
- `f` to pin, scroll the page: the pinned element's overlay and tooltip keep
  tracking it. `↑`/`↓`/`c` still work while pinned.
- Click the toolbar icon: popup shows the shortcut list and the rebind path,
  nothing else.
- Force worker eviction (leave the tab idle a few minutes, or use
  `chrome://serviceworker-internals` to stop it manually), then `Alt+S`: takes
  effect on the **first** press, not the second.
- Firefox (temporary add-on via `about:debugging`): `Alt+S`, hover, `Esc`,
  `Alt+U`, same-origin iframe, `file://`. On Windows/Linux, check `Alt+S`
  isn't swallowed by the menu bar's History access key.
- Full matrix: open `test/testbed.html` (also the `file://` check).
- `node test/smoke.mjs` (needs `CHROME_PATH` pointed at a Chrome for Testing
  build — see `test/harness.mjs`'s header comment) for the automated subset of
  the above.

## Store screenshots

```
node test/screenshots.mjs
```

Same harness as the smoke test (`test/harness.mjs`: Chrome up, extension
loaded, testbed served, inspector on), a 1280×800 emulated viewport, and a
forced light scheme so the host machine's theme doesn't decide what the listing
looks like. Writes five PNGs to `assets/screenshots/` — a publishing artifact,
not part of the extension package.

Unlike the smoke test, this hovers via `Input.dispatchMouseEvent`, so it goes
through real hit-testing: the cursor lands just inside a fixture's bottom-right
corner, which is both clear of the per-side labels (they sit at edge middles)
and, for B11, the one part of the box its child doesn't cover. Each capture
asserts the tooltip names the intended fixture — hovering a child silently
produces a plausible-looking screenshot of the wrong element, which is exactly
what happened on the first run.

## Deferred / not done

- Cross-frame keyboard navigation.
- `←`/`→` sibling navigation (natural complement to `↑`/`↓`, ~15 lines).
- Element-to-element distance measuring, cascade introspection, config UI —
  explicitly out of scope (each doubles the surface area).
- Sub-pixel position advisory (element rendered at a non-integer x/y — blurry
  text/borders). Considered alongside the clamp and viewport-overflow lines;
  held back for now to avoid three new advisory lines at once. Cheap to add
  if it turns out to matter (`rect.left % 1 !== 0`-style check).
- Container-query awareness (highlight/label the nearest `container-type`
  ancestor, show its inline-size). Fits the tool conceptually, but rejected:
  (a) the "flag it as a cause of the red mismatch" idea is a false premise —
  container queries change which rules apply, and `getComputedStyle` already
  returns the used value, so they produce no border-box-vs-rect delta;
  (b) an ancestor highlight costs a sixth overlay color and a second element's
  worth of overlay on CQ-heavy pages. A tooltip-only version stays possible if
  the need ever proves real.

## Conventions

- **Load the `apert-quality` skill** (`.claude/skills/apert-quality/`) before
  writing or reviewing microcopy, overlay CSS, docs, or a module. It is the
  restraint standard for this repo — what is said, shown, and shipped.
- Comments explain *why*, kept dense where a browser quirk is involved.
- No abstraction for its own sake — this is meant to stay a small, readable
  handful of files.
- All overlay CSS scoped under `#layout-lens-root`; classes prefixed `ll-`.
- Message types are `LAYOUT_LENS_*` string constants inline (no shared module).
