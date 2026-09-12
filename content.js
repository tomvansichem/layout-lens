// Layout Lens — content script
//
// A hover inspector that draws DevTools-style padding (green) and margin
// (orange) overlays for the element under the cursor, and — the main point —
// compares the element's CSS size against its actually-rendered size (dashed
// red outline on a mismatch) and flags content clipped by overflow:hidden/clip
// (dashed amber outline).
//
// It is completely inert until background.js sends LAYOUT_LENS_SET (driven by
// the Alt+S command). Toggling off removes every listener and DOM node, leaving
// no trace on the page.
//
// With `all_frames: true` this runs once per frame; each copy is independent and
// operates only on its own document. The background worker broadcasts state to
// every frame so they turn on and off together.

(() => {
  // Guard against double injection into the same frame. The message listener
  // from the first run keeps handling state changes.
  if (window.__LAYOUT_LENS_ACTIVE_INSTANCE__) return;
  window.__LAYOUT_LENS_ACTIVE_INSTANCE__ = true;

  const ROOT_ID = "layout-lens-root";

  // ---- State ---------------------------------------------------------------
  let active = false;
  let rafId = 0;
  let currentEl = null; // element being measured (hovered, or keyboard-selected)
  let metrics = null; // cached getComputedStyle-derived numbers for currentEl
  let mouseX = 0;
  let mouseY = 0;

  // Display unit for every measurement the overlay prints. The measuring stays
  // in CSS pixels throughout — this only converts numbers at render time. Alt+U
  // cycles it; it resets to "px" on reload or on deactivate. No storage.
  const UNITS = ["px", "rem", "em"];
  let unit = "px";
  let unitScale = 1; // px per `unit`; recomputed each frame in render()
  let unitToastTimer = 0;

  // DOM-tree navigation. While `lockedEl` is set, the mouse no longer picks the
  // target — ArrowUp/ArrowDown walk the ancestor chain instead. `originEl` is
  // the deepest element we started from, so ArrowDown can retrace the descent.
  let lockedEl = null;
  let originEl = null;

  // `f` pins the current element: mouse tracking stops (move the cursor to
  // DevTools, or toward another element to eyeball it) but the rAF loop keeps
  // re-reading the pinned element's rect, so it still tracks scroll, resize,
  // and layout animation — useful for comparing it against something further
  // down the page.
  let frozen = false;

  // `c` copies the measurement block. `lastReport` is rebuilt every render;
  // `copiedAt` drives a brief "copied" flash in the tooltip.
  let lastReport = "";
  let copiedAt = 0;

  // Overlay nodes (created on activate, destroyed on deactivate).
  let root = null;
  let marginBox = null;
  let paddingBox = null;
  let outline = null;
  let labelLayer = null;
  let tip = null;
  let unitToast = null; // transient "Unit: rem" label, shown ~1s on Alt+U

  // ---- Small helpers -----------------------------------------------------
  const max0 = (n) => (n > 0 ? n : 0);

  // Format a pixel number: drop the decimal when it's a whole number.
  const r = (n) => {
    const v = Math.round(n * 10) / 10;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };

  // Format a px measurement in the active display unit. px keeps the form above;
  // rem/em divide by `unitScale` and round to 2 decimals — the ×100/100 also
  // clears floating-point noise like 1.4999999. Trailing zeros fall off via
  // String coercion (1.5, not 1.50).
  const fmtLen = (px) =>
    unit === "px" ? r(px) + "px" : Math.round((px / unitScale) * 100) / 100 + unit;

  const fmtDelta = (d) => (d > 0 ? "+" : "-") + fmtLen(Math.abs(d));

  // A full CSS-ish label for an element: tag#id.class.class
  function describe(el) {
    let s = el.tagName ? el.tagName.toLowerCase() : "node";
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) {
      s += "." + Array.from(el.classList).slice(0, 4).join(".");
    }
    return s;
  }

  // A compact label for breadcrumb use: tag plus #id only.
  function tagLabel(el) {
    let s = el.tagName ? el.tagName.toLowerCase() : "node";
    if (el.id) s += "#" + el.id;
    return s;
  }

  // ---- Overlay construction ---------------------------------------------
  function buildOverlay() {
    root = document.createElement("div");
    root.id = ROOT_ID;

    marginBox = div("ll-box ll-margin");
    paddingBox = div("ll-box ll-padding");
    outline = div("ll-box ll-outline");
    labelLayer = div("ll-labels");
    tip = div("ll-tip");
    unitToast = div("ll-unit");

    // Order matters for stacking: margin behind padding behind outline.
    root.append(marginBox, paddingBox, outline, labelLayer, tip, unitToast);

    // documentElement is always present, even on bare file:// or XML pages.
    document.documentElement.appendChild(root);
  }

  function div(className) {
    const d = document.createElement("div");
    d.className = className;
    return d;
  }

  function showBoxes() {
    for (const n of [marginBox, paddingBox, outline, tip]) n.style.display = "block";
  }

  function hideBoxes() {
    for (const n of [marginBox, paddingBox, outline, tip]) n.style.display = "none";
    if (labelLayer) labelLayer.replaceChildren();
    currentEl = null;
    metrics = null;
    lockedEl = null; // any tree-navigation / freeze state is stale once the
    originEl = null; // target is gone
    frozen = false;
    lastReport = "";
  }

  function place(node, x, y, w, h) {
    node.style.left = x + "px";
    node.style.top = y + "px";
    node.style.width = max0(w) + "px";
    node.style.height = max0(h) + "px";
  }

  // ---- Reading computed style ------------------------------------------
  function readMetrics(el) {
    const cs = getComputedStyle(el);
    const n = (v) => {
      const x = parseFloat(v);
      return Number.isFinite(x) ? x : 0;
    };

    const m = {
      mt: n(cs.marginTop), mr: n(cs.marginRight), mb: n(cs.marginBottom), ml: n(cs.marginLeft),
      pt: n(cs.paddingTop), pr: n(cs.paddingRight), pb: n(cs.paddingBottom), pl: n(cs.paddingLeft),
      bt: n(cs.borderTopWidth), br: n(cs.borderRightWidth), bb: n(cs.borderBottomWidth), bl: n(cs.borderLeftWidth),
    };

    // In Chrome, getComputedStyle().width/height resolve to the *used* pixel
    // value after layout. For a content-box element that's the content size,
    // so we add padding + border to get a border-box figure that's directly
    // comparable to getBoundingClientRect().
    //
    // What survives this normalization as a real mismatch: CSS transforms /
    // scale on the element or an ancestor (rect reflects them, computed width
    // doesn't). Clamping, flex-shrink, zoom on modern Chrome, etc. do NOT show
    // up here because getComputedStyle already returns the post-layout value.
    const wRaw = parseFloat(cs.width);
    const hRaw = parseFloat(cs.height);
    const borderBox = cs.boxSizing === "border-box";

    m.cssW = Number.isFinite(wRaw)
      ? borderBox ? wRaw : wRaw + m.pl + m.pr + m.bl + m.br
      : null;
    m.cssH = Number.isFinite(hRaw)
      ? borderBox ? hRaw : hRaw + m.pt + m.pb + m.bt + m.bb
      : null;

    // Which axis, if any, is pinned by an explicit min-/max-width|height rather
    // than by `width`/`height` (or intrinsic/flex sizing). The mismatch check
    // above can't see this: clamping resolves before computed style is read,
    // so cssW/cssH already reflect the clamped value and there's nothing left
    // to compare against. This is a separate, honest "why is it this size"
    // signal — an info line, not a warning, so it's independent of `mismatch`.
    const clampAxis = (raw, minRaw, maxRaw, axisLabel) => {
      const max = parseFloat(maxRaw);
      if (Number.isFinite(max) && Math.abs(raw - max) < 0.5) return { via: `max-${axisLabel}`, px: max };
      const min = parseFloat(minRaw);
      if (Number.isFinite(min) && min > 0 && Math.abs(raw - min) < 0.5) return { via: `min-${axisLabel}`, px: min };
      return null;
    };
    m.clampW = Number.isFinite(wRaw) ? clampAxis(wRaw, cs.minWidth, cs.maxWidth, "width") : null;
    m.clampH = Number.isFinite(hRaw) ? clampAxis(hRaw, cs.minHeight, cs.maxHeight, "height") : null;

    // Overflow mode per axis — used by the clip check in render(). The live
    // scrollWidth/clientWidth numbers are read there, per frame.
    m.ovX = cs.overflowX;
    m.ovY = cs.overflowY;

    // This element's own font-size, the divisor for `em` display. Cached with
    // the rest — it only changes when the target changes. (`rem` divides by the
    // root font-size instead, read fresh each frame.)
    m.fontPx = n(cs.fontSize);

    // Where a transform lives, if any — the usual reason cssW/cssH and the
    // rendered rect disagree. Surfaced in the tooltip only when there's an
    // actual size mismatch, so this walk pays off exactly when it's needed.
    m.xform = null;
    if (cs.transform && cs.transform !== "none") {
      m.xform = "transform on this element";
    } else {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const ct = getComputedStyle(n).transform;
        if (ct && ct !== "none") {
          m.xform = `ancestor ${describe(n)} is transformed`;
          break;
        }
      }
    }

    return m;
  }

  // True for overflow modes that actually hide content (no scrollbar to reach
  // it). `scroll` / `auto` are excluded on purpose — the user can scroll there.
  function clips(mode) {
    return mode === "hidden" || mode === "clip";
  }

  // ---- Rendering one frame -------------------------------------------
  function render(el) {
    // Read everything off the target element up front, before any style writes
    // to the overlay, so the frame costs one layout flush rather than several.
    // scrollWidth/clientWidth are integer-rounded and padding-box based, so
    // their difference is pure hidden content. SVG elements return undefined
    // here; the `>= 1` test below then fails, which is what we want.
    const R = el.getBoundingClientRect();
    const scrollW = el.scrollWidth;
    const clientW = el.clientWidth;
    const scrollH = el.scrollHeight;
    const clientH = el.clientHeight;
    const m = metrics;

    // px per display unit. `rem` reads the root font-size fresh here so a page
    // that overrides <html> font-size is respected; `em` uses the target's own
    // cached font-size. The `|| 16` is only a floor for an unparseable value.
    unitScale =
      unit === "rem" ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 :
      unit === "em" ? m.fontPx || 16 :
      1;

    // Margin ring: box grows outward from the border-box by the margins;
    // the margin values live in this box's border.
    place(marginBox, R.left - m.ml, R.top - m.mt, R.width + m.ml + m.mr, R.height + m.mt + m.mb);
    marginBox.style.borderWidth =
      `${max0(m.mt)}px ${max0(m.mr)}px ${max0(m.mb)}px ${max0(m.ml)}px`;

    // Padding ring: box sits just inside the element's border; the padding
    // values live in this box's border.
    const px = R.left + m.bl;
    const py = R.top + m.bt;
    const pw = R.width - m.bl - m.br;
    const ph = R.height - m.bt - m.bb;
    place(paddingBox, px, py, pw, ph);
    paddingBox.style.borderWidth =
      `${max0(m.pt)}px ${max0(m.pr)}px ${max0(m.pb)}px ${max0(m.pl)}px`;

    // The element's border-box outline.
    place(outline, R.left, R.top, R.width, R.height);

    // ---- Discrepancy check: CSS box size vs rendered size ----
    const vw = R.width;
    const vh = R.height;
    const dW = m.cssW == null ? 0 : vw - m.cssW;
    const dH = m.cssH == null ? 0 : vh - m.cssH;
    const mismatch = Math.abs(dW) > 0.5 || Math.abs(dH) > 0.5;

    // ---- Clip check: content larger than the box, with nowhere to scroll ----
    const clipX = clips(m.ovX) && scrollW - clientW >= 1;
    const clipY = clips(m.ovY) && scrollH - clientH >= 1;
    const clipped = clipX || clipY;

    // Precedence: red size mismatch > amber clip > purple keyboard-lock > plain.
    const showClip = clipped && !mismatch;
    const showLock = !!lockedEl && !mismatch && !clipped;
    outline.classList.toggle("ll-mismatch", mismatch);
    outline.classList.toggle("ll-clip", showClip);
    outline.classList.toggle("ll-locked", showLock);
    tip.classList.toggle("ll-mismatch", mismatch);
    tip.classList.toggle("ll-clip", showClip);
    tip.classList.toggle("ll-locked", showLock);

    const clip = clipped
      ? {
          x: clipX ? { content: scrollW, visible: clientW } : null,
          y: clipY ? { content: scrollH, visible: clientH } : null,
        }
      : null;

    // ---- Viewport-overflow check: does this element's own box extend past
    // where the page should end? A different question from the clip check
    // above (that's the element's content vs its own box; this is the
    // element's box vs the page) — computed live because scroll position
    // changes every frame the check would otherwise miss it.
    const overflowPx = R.right + window.scrollX - document.documentElement.clientWidth;
    const vpOverflow = overflowPx > 0.5 ? overflowPx : null;

    renderLabels(R, m, px, py, pw, ph);
    renderTip(el, m, vw, vh, dW, dH, mismatch, clip, vpOverflow);
    positionTip();
  }

  // Per-side pixel labels. Any side that is 0 (or negative) gets no label.
  function renderLabels(R, m, px, py, pw, ph) {
    labelLayer.replaceChildren();

    const add = (x, y, value, kind) => {
      if (value <= 0.5) return;
      const d = document.createElement("div");
      d.className = "ll-label " + kind;
      d.textContent = fmtLen(value);
      d.style.left = x + "px";
      d.style.top = y + "px";
      labelLayer.appendChild(d);
    };

    const cx = R.left + R.width / 2;
    const cy = R.top + R.height / 2;

    // Padding labels, centered within each padding strip.
    add(px + pw / 2, py + m.pt / 2, m.pt, "ll-pad");
    add(px + pw / 2, py + ph - m.pb / 2, m.pb, "ll-pad");
    add(px + m.pl / 2, py + ph / 2, m.pl, "ll-pad");
    add(px + pw - m.pr / 2, py + ph / 2, m.pr, "ll-pad");

    // Margin labels, centered within each margin strip.
    add(cx, R.top - m.mt / 2, m.mt, "ll-mar");
    add(cx, R.bottom + m.mb / 2, m.mb, "ll-mar");
    add(R.left - m.ml / 2, cy, m.ml, "ll-mar");
    add(R.right + m.mr / 2, cy, m.mr, "ll-mar");
  }

  // Cursor-following info box: ancestor breadcrumb, a prominent element label,
  // sibling position, CSS vs Visual size, a min-/max-width|height clamp line
  // when one applies (independent of mismatch — see clampAxis above), and —
  // only when something is off — the per-axis size variance, transform cause,
  // clipped-content, and/or viewport-overflow lines.
  // Lines marked `report: true` also feed the clipboard copy (`c`).
  function renderTip(el, m, vw, vh, dW, dH, mismatch, clip, vpOverflow) {
    tip.replaceChildren();

    const report = [];
    const line = (text, cls, inReport) => {
      const d = document.createElement("div");
      d.textContent = text;
      if (cls) d.className = cls;
      tip.appendChild(d);
      if (inReport) report.push(text);
    };

    // Breadcrumb: ancestor tags from the root down to (but not including) el.
    const chain = [];
    for (let n = el.parentElement; n; n = n.parentElement) chain.unshift(tagLabel(n));
    if (chain.length) {
      const shown = chain.length > 6 ? ["…"].concat(chain.slice(-6)) : chain;
      line(shown.join("  ›  ") + "  ›", "ll-tip-crumb");
    }

    // The element itself — the prominent line.
    line(describe(el), "ll-tip-sel", true);

    // Where it sits among its siblings, plus the mode indicators.
    const p = el.parentElement;
    const pos = p
      ? `child ${Array.prototype.indexOf.call(p.children, el) + 1} of ${p.children.length}`
      : "root element";
    const tags = [];
    if (frozen) tags.push("PINNED");
    if (lockedEl) tags.push("LOCKED");
    line(
      tags.length ? `${pos}   ·   ${tags.join("  ·  ")}` : pos,
      "ll-tip-meta" + (tags.length ? " ll-tip-locked" : "")
    );

    const cssStr = m.cssW == null ? "CSS n/a" : `CSS ${fmtLen(m.cssW)}×${fmtLen(m.cssH)}`;
    line(`${cssStr}  |  Visual ${fmtLen(vw)}×${fmtLen(vh)}`, null, true);

    // Clamp lines are informational, not a warning — shown independent of
    // `mismatch` since this is precisely the case the size check can't catch.
    if (m.clampW) line(`↳ width pinned by ${m.clampW.via} (${fmtLen(m.clampW.px)}), not width`, "ll-clipwarn", true);
    if (m.clampH) line(`↳ height pinned by ${m.clampH.via} (${fmtLen(m.clampH.px)}), not height`, "ll-clipwarn", true);

    if (mismatch) {
      if (Math.abs(dW) > 0.5) {
        line(`W  CSS ${fmtLen(m.cssW)} → Visual ${fmtLen(vw)}  (${fmtDelta(dW)})`, "ll-warn", true);
      }
      if (Math.abs(dH) > 0.5) {
        line(`H  CSS ${fmtLen(m.cssH)} → Visual ${fmtLen(vh)}  (${fmtDelta(dH)})`, "ll-warn", true);
      }
      if (m.xform) line(`↳ ${m.xform}`, "ll-warn", true);
    }

    if (clip) {
      if (clip.x) {
        line(
          `↔ content ${clip.x.content}px clipped to ${clip.x.visible}px  (${clip.x.content - clip.x.visible}px hidden)`,
          "ll-clipwarn",
          true
        );
      }
      if (clip.y) {
        line(
          `↕ content ${clip.y.content}px clipped to ${clip.y.visible}px  (${clip.y.content - clip.y.visible}px hidden)`,
          "ll-clipwarn",
          true
        );
      }
    }

    if (vpOverflow != null) {
      line(`↔ ${fmtLen(vpOverflow)} wider than the viewport — likely cause of horizontal scroll`, "ll-clipwarn", true);
    }

    lastReport = report.join("\n");

    if (copiedAt && Date.now() - copiedAt < 900) line("✓ copied", "ll-tip-ok");

    let hint;
    if (frozen) hint = "📌 pinned — scroll to compare · f release · c copy · ↑ ↓ navigate";
    else if (lockedEl) hint = "↑ parent  ↓ child · move mouse to release · c copy";
    else hint = "↑ parent · c copy · f pin";
    line(hint, "ll-tip-hint");
  }

  function positionTip() {
    const gap = 14;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = mouseX + gap;
    let y = mouseY + gap;

    if (x + tw > window.innerWidth - 4) x = mouseX - gap - tw;
    if (y + th > window.innerHeight - 4) y = mouseY - gap - th;
    if (x < 4) x = 4;
    if (y < 4) y = 4;

    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  // ---- The rAF loop -------------------------------------------------
  // Runs only while an element is being tracked. Re-reading getBoundingClientRect
  // every frame is what keeps the overlay glued to the element during scroll,
  // resize, and layout animations. getComputedStyle is NOT called here — its
  // result is cached in `metrics` and only refreshed when the target changes.
  // When nothing is hovered the loop stops entirely (important with many
  // iframes, where a spinning idle loop per frame would add up).
  function frame() {
    if (!active) {
      rafId = 0;
      return;
    }
    if (currentEl && currentEl.isConnected) {
      render(currentEl);
      rafId = requestAnimationFrame(frame);
      return;
    }
    // Target gone (removed from the DOM, or never set) — go idle until the
    // next hover restarts the loop via ensureLoop().
    if (currentEl) hideBoxes();
    rafId = 0;
  }

  function ensureLoop() {
    if (active && !rafId) rafId = requestAnimationFrame(frame);
  }

  // ---- Event handlers ---------------------------------------------
  function applyTarget(el) {
    currentEl = el;
    metrics = readMetrics(el);
    showBoxes();
    ensureLoop();
  }

  // Mouse-driven targeting. Ignored while frozen or while keyboard navigation
  // holds the lock.
  function setTarget(el) {
    if (!(el instanceof Element)) return;
    if (root && root.contains(el)) return; // never inspect our own overlay
    if (frozen || lockedEl || el === currentEl) return;
    applyTarget(el);
  }

  function navigateUp() {
    if (!currentEl) return;
    const parent = currentEl.parentElement;
    if (!parent) return; // already at <html>
    if (!lockedEl) originEl = currentEl; // remember the descent starting point
    lockedEl = parent;
    applyTarget(parent);
  }

  function navigateDown() {
    if (!lockedEl) return;
    if (!originEl || lockedEl === originEl) {
      releaseLock(); // one more press past the origin exits navigation
      return;
    }
    // Walk up from the origin until we find the direct child of lockedEl.
    let child = originEl;
    while (child.parentElement && child.parentElement !== lockedEl) {
      child = child.parentElement;
    }
    if (child.parentElement === lockedEl) {
      lockedEl = child;
      applyTarget(child);
    } else {
      releaseLock();
    }
  }

  function releaseLock() {
    lockedEl = null;
    originEl = null;
    retargetUnderCursor();
  }

  // Point the inspector at whatever is under the cursor right now.
  function retargetUnderCursor() {
    const hit = document.elementFromPoint(mouseX, mouseY);
    if (hit instanceof Element && !(root && root.contains(hit))) applyTarget(hit);
  }

  function toggleFreeze() {
    frozen = !frozen;
    // On unfreeze, don't retarget from the stale cursor position — the next
    // real mousemove picks the element under the pointer. If the mouse stays
    // put, keeping the current target shown is the intuitive result.
    ensureLoop();
  }

  // Alt+U — step the display unit px → rem → em → px. Flash the choice for ~1s
  // so there's feedback without a permanent readout, then let the running rAF
  // loop repaint labels and tip in the new unit.
  function cycleUnit() {
    unit = UNITS[(UNITS.indexOf(unit) + 1) % UNITS.length];
    unitToast.textContent = "Unit: " + unit;
    unitToast.style.opacity = "1";
    clearTimeout(unitToastTimer);
    unitToastTimer = setTimeout(() => {
      unitToast.style.opacity = "0";
    }, 1000);
    ensureLoop();
  }

  function copyReport() {
    if (!lastReport) return;
    copyText(lastReport);
    copiedAt = Date.now();
    ensureLoop(); // guarantee the "copied" flash gets a frame
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => execCopy(text));
    } else {
      execCopy(text); // http / other non-secure contexts
    }
  }

  function execCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
    document.documentElement.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {
      /* nothing else to try */
    }
    ta.remove();
  }

  function onMouseOver(e) {
    if (frozen) return;
    setTarget(e.target);
  }

  function onMouseMove(e) {
    if (frozen) return; // hard stop: don't move the tooltip or retarget
    mouseX = e.clientX;
    mouseY = e.clientY;
    const hit = document.elementFromPoint(mouseX, mouseY);
    if (lockedEl) {
      // Moving the pointer clear of the element we started from releases the
      // lock and hands targeting back to the mouse.
      if (originEl && hit instanceof Element && hit !== originEl && !originEl.contains(hit)) {
        releaseLock();
      }
      return;
    }
    // Fallback targeting in case a page stops mouseover propagation. Our
    // overlay is pointer-events:none, so elementFromPoint returns the real
    // page element beneath the cursor.
    setTarget(hit);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      deactivate();
      // Tell the worker so it clears tab state and turns off any other frames.
      try {
        const p = chrome.runtime.sendMessage({ type: "LAYOUT_LENS_ESC" });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) {
        // Extension context torn down mid-teardown — nothing to do.
      }
      return;
    }

    // Don't steal keystrokes from a field the user is typing in.
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
      return;
    }

    // `f` — freeze / unfreeze mouse tracking. Works with or without a target
    // (so you can always unfreeze). Held as a deliberate mode, so claim the key.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) toggleFreeze();
      return;
    }

    // `c` — copy the measurement block. Only claim it when there's something to
    // copy and no modifier is held (never shadow Ctrl/Cmd+C).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "c" || e.key === "C")) {
      if (!currentEl) return; // nothing to copy — let the page have the key
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) copyReport();
      return;
    }

    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

    // Nothing hovered yet — leave the arrows alone so the page scrolls normally.
    if (!currentEl && !lockedEl) return;

    // Repurpose the arrows for DOM-tree navigation. This listener runs on
    // `window` in the capture phase, so stopping propagation here also blocks
    // smooth-scroll libraries (Lenis, Locomotive, GSAP ScrollSmoother) that
    // scroll from their own keydown handler — preventDefault alone wouldn't.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (e.repeat) return; // one physical press = one step
    if (e.key === "ArrowUp") navigateUp();
    else navigateDown();
  }

  // ---- Activate / deactivate ------------------------------------
  function activate() {
    if (active) return;
    active = true;
    buildOverlay();
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("keydown", onKeyDown, true);
    // The rAF loop starts on the first hover (applyTarget -> ensureLoop).
  }

  function deactivate() {
    if (!active) return;
    active = false;
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("keydown", onKeyDown, true);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clearTimeout(unitToastTimer);
    unitToastTimer = 0;
    if (root) root.remove();
    root = marginBox = paddingBox = outline = labelLayer = tip = unitToast = null;
    currentEl = null;
    metrics = null;
    lockedEl = null;
    originEl = null;
    frozen = false;
    unit = "px"; // resets with the tool — no unit persists across a toggle
    unitScale = 1;
    lastReport = "";
    copiedAt = 0;
  }

  // ---- Message from the service worker ------------------------
  // The worker owns the on/off state and pushes it here. activate() and
  // deactivate() are both idempotent, so a redundant SET is harmless.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "LAYOUT_LENS_SET") {
      if (msg.active) activate();
      else deactivate();
    } else if (msg.type === "LAYOUT_LENS_CYCLE_UNIT") {
      if (active) cycleUnit();
    }
  });
})();
