#!/usr/bin/env node
// Layout Lens — Chrome Web Store screenshots
//
// Captures the listing images from the real extension hovering real elements
// in test/testbed.html, so they show the overlay as it actually paints. The
// Store accepts 1280×800 or 640×400 only; these are 1280×800 and the size is
// asserted from each PNG's own header before it's written. The page is laid
// out at 1280×800 / SCALE and captured at SCALE×, so the overlay text is
// readable in the listing instead of an 11px tooltip in a full desktop frame.
//
// Chrome is launched by test/harness.mjs — read its header for the
// CHROME_PATH / "Chrome for Testing" requirement.
//
// Output goes to assets/screenshots/, which is a publishing artifact — not
// part of the extension package.
//
// Usage:  node test/screenshots.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, sleep, startInspector, waitFor } from "./harness.mjs";

const WIDTH = 1280;
const HEIGHT = 800;
const SCALE = 2;
const VIEW_W = WIDTH / SCALE;
const VIEW_H = HEIGHT / SCALE;
// Space kept above each fixture. The fixture sits near the top of the frame
// so the tooltip, which hangs below the cursor, has room there instead of
// flipping up over the element it describes.
const TOP = 48;
const outDir = join(repoRoot, "assets", "screenshots");

// Ordered as they should appear on the listing: what the tool shows on any
// element first, then the four things it catches.
const shots = [
  { file: "1-padding-margin.png", id: "fx-padding", name: "A1 · padding + margin rings" },
  { file: "2-size-mismatch.png", id: "fx-transform", name: "B1 · CSS size vs rendered size" },
  { file: "3-clipped-content.png", id: "fx-clip", name: "B11 · clipped content" },
  { file: "4-min-width-clamp.png", id: "fx-clamp", name: "B9 · width pinned by min-width" },
  { file: "5-viewport-overflow.png", id: "fx-vpoverflow", name: "D1 · wider than the viewport" },
];

// PNG dimensions live in the IHDR chunk, two big-endian uint32s at a fixed
// offset — enough to catch a screenshot that came back at the host's device
// pixel ratio instead of the Store's size, which would otherwise only surface
// at upload time.
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function capture(page, shot) {
  const at = await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(shot.id)});
    if (!el) throw new Error("fixture not found: ${shot.id}");
    el.scrollIntoView({ block: "start" });
    scrollBy(0, -${TOP});
    // Never leave the page scrolled sideways: D1 is wider than the frame, and
    // the shot should show it running off the edge, not a shifted page.
    document.scrollingElement.scrollLeft = 0;
    const r = el.getBoundingClientRect();
    // Cursor just inside the bottom-right corner. The tooltip hangs down-right
    // of the cursor, so from there it falls clear of the element and of the
    // per-side labels, which sit at the middle of each edge — and the corner is
    // the one part of a box like B11 that its child doesn't cover. Clamped for
    // fixtures larger than the frame (D1).
    return {
      x: Math.round(Math.min(r.right - 8, innerWidth - 40)),
      y: Math.round(Math.min(r.bottom - 8, innerHeight - 40)),
      scrollY,
    };
  })()`);

  // Two moves: the first crosses into the element (mouseover), the second is
  // the mousemove the overlay positions the tooltip from.
  for (let i = 0; i < 2; i++) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await sleep(50);
  }

  // Real hit-testing, unlike the smoke test's synthetic dispatch, can land on a
  // child or a neighbour — which silently produces a correct-looking screenshot
  // of the wrong element. The tooltip names what it measured; hold it to that.
  const measured = await waitFor(() =>
    page.evaluate('document.querySelector("#layout-lens-root .ll-tip-sel")?.textContent || ""')
  );
  if (!measured.includes(shot.id)) {
    throw new Error(`${shot.file}: the overlay is measuring ${measured}, not #${shot.id}`);
  }
  await sleep(150); // a few rAF frames, so the rings sit on the final rect

  // The scale lives in the capture, not in a device pixel ratio: with
  // deviceScaleFactor 2, headless Chrome kept returning the frame from right
  // after the scroll, so every shot but the first showed the overlay still on
  // the fixture's container. A clip with a scale renders a fresh frame.
  // Clip coordinates are document-relative, hence scrollY.
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: at.scrollY, width: VIEW_W, height: VIEW_H, scale: SCALE },
  });
  const buf = Buffer.from(data, "base64");
  const { width, height } = pngSize(buf);
  if (width !== WIDTH || height !== HEIGHT) {
    throw new Error(`${shot.file}: captured ${width}×${height}, the Store needs ${WIDTH}×${HEIGHT}`);
  }
  writeFileSync(join(outDir, shot.file), buf);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const { page, close } = await startInspector({
    chromeArgs: [`--window-size=${VIEW_W},${VIEW_H}`],
  });

  try {
    // The window size sets the frame; the override pins the viewport and the
    // pixel ratio, so the layout is the same on any host. Light scheme is
    // forced because testbed.html is theme-aware and the machine running this
    // shouldn't decide what the listing looks like.
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: VIEW_W,
      height: VIEW_H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await sleep(200); // let the resize settle

    for (const shot of shots) {
      await capture(page, shot);
      console.log(`  ${shot.file}  —  ${shot.name}`);
    }
  } finally {
    await close();
  }

  console.log(`\n${shots.length} screenshots in assets/screenshots/`);
}

main().catch((err) => {
  console.error("Screenshots failed:", err);
  process.exit(1);
});
