# Layout Lens

A lightweight Chrome extension (Manifest V3) that answers one question on
hover: **why is this element the size it is?** It draws the familiar padding/
margin overlay, then goes further than DevTools does on the sizing question
itself:

- an element whose **CSS box size doesn't match what actually rendered** — CSS
  transforms on the element or an ancestor (red);
- **content clipped out of view** by `overflow: hidden` / `clip`, including
  `text-overflow: ellipsis` truncation (amber);
- an element's width or height **pinned by `min-`/`max-width`/`height`**
  rather than by `width`/`height` itself (an info line, not a warning);
- an element that's **wider than the viewport**, a common cause of an
  unwanted horizontal scrollbar (an info line, not a warning).

> **Status:** `1.0.0`. A few known limitations are listed below.

Requests one permission (`activeTab`), plus `storage` for a memory-only flag
that survives the browser evicting the extension's idle worker — nothing is
ever written to disk. The toolbar popup is static help text; no options page,
no settings. It does nothing until you press the shortcut.

---

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. *(Optional, for `file://` pages)* click **Details** on the Layout Lens card
   and enable **Allow access to file URLs**. Chrome requires this per-extension
   toggle; no manifest setting can grant it.

### Change the shortcut

Defaults are **`Alt+S`** (toggle) and **`Alt+U`** (cycle unit). Rebind either at
`chrome://extensions/shortcuts`.

---

## Use

| Action | Result |
| --- | --- |
| Press **`Alt+S`** | Toggle the inspector on/off for the current tab (all frames) |
| Move the mouse | Measures the element under the cursor |
| **`↑`** | Select the **parent** of the current element |
| **`↓`** | Walk back **down** toward where you started |
| Move the mouse off that element | Releases keyboard navigation |
| **`c`** | Copy the measurement block (selector + sizes + any warning) to the clipboard |
| **`f`** | Pin / unpin the current element — mouse tracking stops, but the overlay keeps following the pinned element through scroll, so you can move the cursor to DevTools, or scroll to compare it against something else |
| **`Alt+U`** | Cycle the displayed unit: `px` → `rem` → `em` → `px`. Display only — measuring stays in pixels. Resets to `px` on reload |
| **`Esc`** | Turn the inspector off |

The page stays fully interactive while the inspector is on — clicks, hovers,
scrolling all work. Wheel/trackpad scrolling still works during keyboard
navigation; only `↑`/`↓`/`c`/`f` are intercepted, and never while you're typing
in a field.

### What you see

- **Green** overlay = padding, **orange** = margin. The pixel value sits in each
  strip; sides that are `0` get no label.
- The tooltip shows `CSS W×H | Visual W×H`, an ancestor breadcrumb, and the
  element's position among its siblings.
- **Bold dashed red outline** + a variance line (`W CSS 300px → Visual 240px
  (-60px)`) — the CSS box size and the rendered size disagree. A `↳` line names
  the cause when it's a transform (`↳ ancestor div.stage is transformed`).
- **Bold dashed amber outline** + a clip line (`↔ content 520px clipped to
  200px (320px hidden)`) — content is larger than the box and `overflow`
  hides it with no scrollbar to reach it.
- **Amber info lines, no outline change** — two separate, independent signals
  that explain a size without claiming it's a bug:
  `↳ width pinned by min-width (360px), not width` when `min-`/`max-width`
  (or `-height`) is what's actually sizing the element, and `↔ 500px wider
  than the viewport — likely cause of horizontal scroll` when the element's
  own box extends past the page. Both can appear alongside a plain, red, or
  amber-clip outline.
- **Solid purple outline** = you reached this element with `↑`/`↓` rather than
  the mouse.
- Matching sizes with nothing clipped stay quiet — just the green/orange
  overlays and the info tooltip.
- **`Alt+U`** switches every printed number between `px`, `rem` (÷ the root
  font-size), and `em` (÷ the hovered element's own font-size). A brief
  `Unit: rem` label confirms the change; the underlying measuring never leaves
  pixels.

Priority when more than one applies: red (size mismatch) > amber (clip) >
purple (keyboard nav).

**What the size check does and doesn't catch.** It normalizes `box-sizing`
first, so an ordinary padded element is *not* a mismatch. It fires on
layout-vs-paint differences — CSS `transform` / `scale` on the element or an
ancestor. It does **not** fire on `min`/`max` clamping, `flex-shrink`, or
`zoom` on current Chrome: `getComputedStyle()` already reports the post-layout
value in those cases, so there's nothing to compare against. `min`/`max`
clamping is still named, though — via the separate info line above, not the
red check. See `test/testbed.html` for a worked example of every case.

---

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `activeTab`, `storage` (for `storage.session` only). Content script on `<all_urls>`, all frames. |
| `background.js` | Service worker. Owns per-tab on/off state (in `chrome.storage.session`), broadcasts it to every frame, handles the `Alt+S` / `Alt+U` commands and `Esc`. |
| `content.js` | The inspector. Inert until the worker sends `LAYOUT_LENS_SET`. |
| `overlay.css` | Overlay styles, all scoped to `#layout-lens-root` (no effect until active). |
| `popup.html` | Toolbar popup — static shortcut list, no script, no options. |
| `icons/` | Generated PNGs — run `node tools/gen-icons.js` to rebuild. |
| `tools/gen-icons.js` | Dependency-free icon generator. |
| `test/testbed.html` | Every case in this README, laid out for hovering. |
| `test/harness.mjs` | Dependency-free CDP harness — launches Chrome with the extension loaded and the testbed open. |
| `test/smoke.mjs` | Smoke test over that harness. `node test/smoke.mjs`. |
| `test/screenshots.mjs` | Captures the store screenshots from the real overlay. `node test/screenshots.mjs`. |

No build step. Plain JS. Nothing to install.

---

## Known limitations

- **Cross-frame navigation:** `↑`/`↓` walk the DOM of one frame only; they can't
  cross an `<iframe>` boundary. Hovering into a same-origin iframe measures
  elements inside it; you may briefly see two overlays (parent highlighting the
  `<iframe>` element, child highlighting the inner element).
- **Clip check only covers `hidden` / `clip`.** `overflow: auto` / `scroll`
  containers are excluded on purpose — that content is reachable by scrolling,
  not lost.
- **Icons** are minimal generated art, fine for unpacked use; polish before any
  Web Store listing.

## Roadmap

- Cross-frame keyboard navigation.
- `←`/`→` sibling navigation.
