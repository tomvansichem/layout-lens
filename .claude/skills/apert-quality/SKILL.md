---
name: apert-quality
description: Apert's quality discipline applied to Layout Lens — restraint in what is said (tooltip text, labels, docs, comments), what is shown (the overlay), and what is shipped (JS, CSS, the extension's footprint on every page). Load before writing or reviewing any microcopy, overlay style, doc, or module in this extension.
---

# Apert quality standards — Layout Lens

Apert builds things "reduced to their essence." That is not a style, it is the
operating instruction. Every line of copy, every CSS rule, every module here has
to earn its place or it gets cut.

Restraint is applied identically to three things:

- **what is said** — `renderTip()` lines and the hint string in `content.js`, the spacing labels, `manifest.json`'s `description`, `README.md`, `CLAUDE.md`, code comments;
- **what is shown** — the `#layout-lens-root` overlay, the tool's only visible surface;
- **what is shipped** — `content.js` / `background.js` / `overlay.css`, and the cost the extension puts on every page it loads into.

An overlay that measures one number but ships a helper layer it doesn't need has
failed the same way a tooltip line padded with a verb it doesn't need has.

The test for anything you add: **does removing this make it worse, or just
shorter?** If the latter, remove it.

This codebase is already Apert-shaped — no build step, no dependencies, one
permission, inert until a keypress, zero trace on deactivate. Keep it there.

---

## 1. Microcopy

- **Fragments, not sentences.** `↑ parent · c copy · f freeze` — no verbs, no
  "you can". `↔ content 520px clipped to 200px` — a statement, not a warning
  sentence. Don't add "the" and "is" back in.
- **State what a thing is or does, plainly.** This is a developer tool; there is
  no benefit to sell. `CSS 300×150 | Visual 240×120` needs no framing.
- **Plain, physical verbs**: copy, freeze, walk, clip, flag, pin, track. Never
  `leverage`, `streamline`, `unlock`, "enable seamless…".
- **One adjective, or none**, and a plain one.
- **Tooltip and label strings stay glanceable** — every one currently sits under
  ~7 words. That is the ceiling. `README.md` prose is the deliberate exception,
  the way legal copy is the exception on a marketing site.
- **No exclamation marks. Em-dash only for a real separation**, never for energy.

### The exception: comments that explain a browser quirk

`CLAUDE.md` and the comments guarding known gotchas (the `!important`-beats-inline
positioning trap; capture-phase `stopImmediatePropagation` for smooth-scroll
libraries) are allowed to be full, precise prose. Their essence is exactness,
not brevity. Never trim a comment that is stopping a future regression.

### Banned, in docs or UI text

`innovative`, `leading` / `industry-leading`, `cutting-edge`, `seamless`,
`unlock`, `streamline`, `solutions` (standing in for the actual work),
`leverage` / `benefit from` (as corporate-speak), `state-of-the-art`,
`powerful`, `robust`, `blazing-fast`, `game-changer`, `effortless`, `simply` /
`just` (as filler), any exclamation mark in prose, any "we believe" framing.

If a sentence needs one of these, it is doing too much — cut it to what the code
actually does, stated flat. (cf. the README line "catches the two silent layout
lies" — names the effect, no adjective.)

---

## 2. The overlay

`overlay.css` plus the nodes built in `content.js` are the entire visible
product.

- **It gets out of the way.** `pointer-events: none`, never obscures the page,
  leaves nothing behind on deactivate. Non-negotiable.
- **The colour set is closed.** Green / orange for padding / margin; blue, red,
  amber, purple for the four outline states. That is the whole palette. A new
  state does not get a new colour — reuse one, or question whether it is really
  a separate state.
- **Motion is near-zero.** The overlay is rAF-tracked, not animated. If a
  transition is ever added it is `transform` / `opacity` only, ≤ 0.25s, no
  bounce, no spin. The `✓ copied` flash is a text swap on a timer, not an
  animation — keep additions in that spirit.
- **Physical coordinates are correct here.** Unlike an Apert site, this code
  writes `left` / `top` / `width` / `height` on purpose — it is drawing the
  geometry `getBoundingClientRect()` reports. Do not "modernise" it to logical
  properties.
- **One namespace.** Everything scoped under `#layout-lens-root`, classes
  prefixed `ll-`, no global selectors, `!important` only where documented (so
  page CSS can't distort a measurement). No new top-level selector.
- **No magic numbers.** Every value in `overlay.css` is either a named state
  colour or geometry derived from the measured element. A stray `13px` that is
  neither is a question to answer, not a value to keep.

---

## 3. Code

`CLAUDE.md` states the hard constraints. This is the discipline behind them.

- **No abstraction for its own sake.** Compose from the helpers, state, overlay
  nodes, and message constants that already exist. A helper earns extraction
  when it is genuinely repeated and load-bearing — not on the second similar
  line.
- **Every module-scope `let` is a cost.** `frozen`, `lastReport`, `copiedAt`
  each exist because a user-facing capability needs them. Don't add state for
  internal tidiness.
- **Deliberate non-DRY stays.** Message types are inline strings, not a shared
  module. Don't consolidate for neatness.
- **No dependencies, no build, no config surface.** A feature that wants a
  settings toggle is usually a feature whose scope is wrong — raise that before
  building it.

---

## 4. Technical

No pages, no SEO, no framework, so most of a website's technical checklist does
not apply. What does:

- **The tool must be cheap.** It loads on every page. rAF runs only while an
  element is tracked; `getComputedStyle` is cached per target; element reads are
  batched before overlay writes. Any change keeps that shape.
- **`test/testbed.html` stays a plain page** — one `<h1>`, semantic sections,
  self-contained (no external requests), theme-aware. It is a fixture, not a
  place to be clever.
- **Verify rendering by looking, not by computed value.** The founding premise
  of this tool: `getComputedStyle` can report `outline: solid 2px` on an element
  that paints no outline (an `outline` on `display:inline` wrapping a
  `display:block` child splits into empty fragments). Screenshot the result.

---

## 5. Before a change is done

1. **State its one job in a sentence.** If it contains "and", or the change
   needs a toggle, narrow it first.
2. **Write the microcopy first**, shortest unambiguous form, checked against §1.
3. **Compose from what exists** (§3). New primitive only when nothing stretches.
4. **Match the overlay's language** (§2): closed palette, near-zero motion,
   `ll-` scope.
5. **Keep the footprint**: no deps, no build, rAF only while tracking, reads
   before writes, zero trace on deactivate.
6. **The closing test:** if the diff could be shorter — fewer lines, fewer
   states, fewer selectors, fewer words — without losing what it does, it isn't
   finished.
