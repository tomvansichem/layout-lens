#!/usr/bin/env node
// Layout Lens — smoke test
//
// Guards the things that are easy to silently break: the border-box/transform
// math behind the red mismatch, the clip check, the two advisory lines, and
// that deactivate() really leaves no trace. It drives a real headless Chrome
// over the DevTools Protocol against test/testbed.html.
//
// Chrome is launched by test/harness.mjs — read its header for the
// CHROME_PATH / "Chrome for Testing" requirement and what this flow does not
// exercise (the literal Alt+S key dispatch).
//
// Usage:  node test/smoke.mjs

import { sleep, startInspector } from "./harness.mjs";

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// One dispatch-and-read cycle: hover the fixture, let a couple of rAF frames
// settle, read the overlay state back out.
async function hoverAndRead(page, fixtureId) {
  await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(fixtureId)});
    if (!el) throw new Error("fixture not found: ${fixtureId}");
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    return true;
  })()`);
  await sleep(250); // a few rAF frames

  return page.evaluate(`(() => {
    const root = document.getElementById("layout-lens-root");
    if (!root) return { active: false };
    const outline = root.querySelector(".ll-outline");
    const tip = root.querySelector(".ll-tip");
    return {
      active: true,
      mismatch: outline.classList.contains("ll-mismatch"),
      clip: outline.classList.contains("ll-clip"),
      tipText: tip.textContent,
    };
  })()`);
}

const cases = [
  {
    id: "fx-control",
    name: "B5 · control, no transform",
    expect: (s) => [
      ["no mismatch", !s.mismatch],
      ["no clip", !s.clip],
      ["no clamp line", !s.tipText.includes("pinned by")],
      ["no viewport-overflow line", !s.tipText.includes("wider than the viewport")],
    ],
  },
  {
    id: "fx-transform",
    name: "B1 · transform: scale(0.8)",
    expect: (s) => [
      ["mismatch fires", s.mismatch],
      ["names the cause", s.tipText.includes("transform on this element")],
    ],
  },
  {
    id: "fx-clip",
    name: "B11 · overflow:hidden clipping content",
    expect: (s) => [
      ["clip fires", s.clip],
      ["no mismatch", !s.mismatch],
      ["reports clipped content", s.tipText.includes("clipped to")],
    ],
  },
  {
    id: "fx-clamp",
    name: "B9 · min-width clamp",
    expect: (s) => [
      ["no mismatch (clamping is invisible to the size check)", !s.mismatch],
      ["names the clamp", s.tipText.includes("pinned by min-width")],
    ],
  },
  {
    id: "fx-vpoverflow",
    name: "D1 · wider than the viewport",
    expect: (s) => [
      ["flags viewport overflow", s.tipText.includes("wider than the viewport")],
      ["no mismatch", !s.mismatch],
      ["no clip", !s.clip],
    ],
  },
];

async function main() {
  const { page, sw, tabId, close } = await startInspector();

  try {
    for (const c of cases) {
      console.log(c.name);
      const state = await hoverAndRead(page, c.id);
      if (!state.active) {
        check("overlay is active", false, "root node never appeared");
        continue;
      }
      for (const [label, cond] of c.expect(state)) check(label, cond, state.tipText);
    }

    console.log("\nDeactivate");
    await sw.evaluate(`chrome.tabs.sendMessage(${tabId}, { type: "LAYOUT_LENS_SET", active: false })`);
    await sleep(150);
    const afterOff = await page.evaluate('document.getElementById("layout-lens-root") === null');
    check("no trace left after deactivate", afterOff);
  } finally {
    await close();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failing check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
