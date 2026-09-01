# Layout Lens

A lightweight Chrome extension (Manifest V3) that inspects **padding, margin, and
element size on hover**, and flags two kinds of layout surprise:

- an element whose **CSS box size doesn't match what actually rendered** — CSS
  transforms on the element or an ancestor (red);
- **content clipped out of view** by `overflow: hidden` / `clip`, including
  `text-overflow: ellipsis` truncation (amber).

> **Status:** `0.9.0` — beta. Works well; a few rough edges are listed below.

No popup, no options page, no settings, no storage. It does nothing until you
press the shortcut.

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
| **`f`** | Freeze / unfreeze mouse tracking — pins the overlay so you can move the cursor to DevTools or another element |
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
value in those cases, so there's nothing to compare against. See
`test/testbed.html` for a worked example of every case.

---

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Only permission: `activeTab`. Content script on `<all_urls>`, all frames. |
| `background.js` | Service worker. Owns per-tab on/off state, broadcasts it to every frame, handles the `Alt+S` / `Alt+U` commands and `Esc`. |
| `content.js` | The inspector. Inert until the worker sends `LAYOUT_LENS_SET`. |
| `overlay.css` | Overlay styles, all scoped to `#layout-lens-root` (no effect until active). |
| `icons/` | Generated PNGs — run `node tools/gen-icons.js` to rebuild. |
| `tools/gen-icons.js` | Dependency-free icon generator. |

No build step. Plain JS. Nothing to install.

---

## Known limitations (beta)

- **Cross-frame navigation:** `↑`/`↓` walk the DOM of one frame only; they can't
  cross an `<iframe>` boundary. Hovering into a same-origin iframe measures
  elements inside it; you may briefly see two overlays (parent highlighting the
  `<iframe>` element, child highlighting the inner element).
- **Service worker eviction:** on/off state lives in the worker's memory (no
  storage). If Chrome evicts the worker while the inspector is active, the next
  `Alt+S` may need one extra press to re-sync.
- **Clip check only covers `hidden` / `clip`.** `overflow: auto` / `scroll`
  containers are excluded on purpose — that content is reachable by scrolling,
  not lost.
- **Icons** are minimal generated art, fine for unpacked use; polish before any
  Web Store listing.

## Roadmap

- Optional: copy the selector or measurements to the clipboard.
- Optional: freeze/pin the current measurement.
- Cross-frame keyboard navigation.
