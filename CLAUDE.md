# CLAUDE.md — Layout Lens

Working notes for developing this extension. Read alongside `README.md` (user-facing).

## What it is

MV3 Chrome extension. A hover inspector for padding/margin + a **CSS-size vs
rendered-size discrepancy** checker. Shortcut-activated only — deliberately no
popup, no options page, no storage, no toolbar `action`.

## Hard constraints (don't regress these)

- **No build step.** Plain JS, loadable via "Load unpacked". No bundler, no deps.
- **No `chrome.storage`**, no persistent state of any kind.
- **Minimal permissions.** Only `activeTab`. No host permissions, no `tabs`,
  no `scripting`. `activeTab` is granted on command execution, which is what
  lets the worker `sendMessage` the content scripts.
- **`pointer-events: none`** on every overlay node — the page must stay fully
  interactive while active.
- **Zero trace on deactivate** — every listener removed, overlay DOM gone.
- Must work identically on live sites, `localhost`, and `file://`
  (`file://` also needs the user's "Allow access to file URLs" toggle).

## Architecture

Three files do the work: `manifest.json`, `background.js`, `content.js`, plus
`overlay.css`.

```
Alt+S  ──> chrome.commands.onCommand (background.js)
             │  flips tabActive.get(tabId)
             ▼
       broadcast: chrome.tabs.sendMessage(tabId, {type:"LAYOUT_LENS_SET", active})
             │  (no frameId => every frame)
             ▼
       content.js onMessage ──> activate() / deactivate()   [idempotent]

Esc (content.js) ──> deactivate() locally
                 └─> chrome.runtime.sendMessage({type:"LAYOUT_LENS_ESC"})
                       ▼
                 background: tabActive.set(tabId,false) + broadcast(false)
```

**The worker is the single source of truth for on/off state.** Content scripts
never flip their own state independently — that's what keeps multi-frame pages
in sync (one `Alt+S` = whole tab, `Esc` anywhere = whole tab off).
`tabActive` is an in-memory `Map` in the worker; it's intentionally not
persisted. Cleared on tab close and on `status === "loading"`.

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
- **Freeze (`f`):** `frozen` flag. `onMouseOver`/`onMouseMove`/`setTarget` all
  bail while set, so the overlay and tooltip stay put. `↑`/`↓`/`c` still work.
  Unfreeze retargets under the cursor. Cleared on `hideBoxes`/`deactivate`.
- **Copy (`c`):** `renderTip` rebuilds `lastReport` every frame from the lines
  it marks `report:true` (selector, sizes, warnings — not the breadcrumb/hint).
  `copyText` uses `navigator.clipboard` with an `execCommand` fallback for
  non-secure contexts. `copiedAt` drives a 900ms `✓ copied` line; the running
  rAF loop clears it. Both keys are guarded against editable `e.target` and
  against `ctrl`/`meta`/`alt` (never shadow Ctrl/Cmd+C).
- **Transform cause:** `readMetrics` sets `m.xform` — `"transform on this
  element"` or `ancestor <sel> is transformed` (walks `parentElement` calling
  `getComputedStyle`). Shown as a `↳` line only inside the mismatch block.
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

## Regenerating icons

```
node tools/gen-icons.js
```

Dependency-free (Node `zlib` only). Art = the tool's own language: dark rounded
tile, orange margin ring → green padding ring → light content square. Colors
match `overlay.css` (`#f6b26b`, `#87c882`).

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
- Full matrix: open `test/testbed.html` (also the `file://` check).

## Deferred / not done

- Cross-frame keyboard navigation.
- `←`/`→` sibling navigation (natural complement to `↑`/`↓`, ~15 lines).
- `cs.width === cs.minWidth` / `=== cs.maxWidth` heuristic — an info line noting
  the size is pinned by a constraint, not `width`. The honest, cheap 80% of
  "clamping detection" without walking stylesheets. Not built.
- Element-to-element distance measuring, cascade introspection, config UI —
  explicitly out of scope (each doubles the surface area).
- `chrome.storage.session` for state survival across worker eviction — rejected
  so far to keep the "no storage" property.

## Conventions

- **Load the `apert-quality` skill** (`.claude/skills/apert-quality/`) before
  writing or reviewing microcopy, overlay CSS, docs, or a module. It is the
  restraint standard for this repo — what is said, shown, and shipped.
- Comments explain *why*, kept dense where a browser quirk is involved.
- No abstraction for its own sake — this is meant to stay a small, readable
  handful of files.
- All overlay CSS scoped under `#layout-lens-root`; classes prefixed `ll-`.
- Message types are `LAYOUT_LENS_*` string constants inline (no shared module).
