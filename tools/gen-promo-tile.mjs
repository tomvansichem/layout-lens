#!/usr/bin/env node
// Layout Lens — Chrome Web Store small promotional tile
//
// Rasterizes assets/promo/small-tile.svg (hand-made, viewBox 0 0 440 280) to
// assets/promo/small-tile.png at the exact size the Store's "Small tile" slot
// wants — 440×280, no scaling. Store submission is a manual, user-only step
// (see TODO.md); this only produces the asset.
//
// Reuses test/harness.mjs's Chrome launcher and CDP client rather than
// duplicating them — same Chrome-for-Testing requirement and CHROME_PATH env
// var as test/smoke.mjs and test/screenshots.mjs (see harness.mjs's header
// comment). No extension load and no testbed server needed here, so this
// doesn't call startInspector() — it drives Chrome directly.
//
// The SVG is inlined into a tiny wrapper page and loaded as a data: URL
// rather than opened directly via file://: Chrome's default viewer for a
// standalone SVG document doesn't reliably fill the viewport at its intrinsic
// size (scrollbars, centering), and inlining also means this always
// rasterizes whatever small-tile.svg currently contains, with nothing to
// fall out of sync.
//
// Usage:  node tools/gen-promo-tile.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDP, findChrome, repoRoot, sleep, waitFor, waitForDevtoolsUrl } from "../test/harness.mjs";

const WIDTH = 440;
const HEIGHT = 280;
const srcPath = join(repoRoot, "assets", "promo", "small-tile.svg");
const outPath = join(repoRoot, "assets", "promo", "small-tile.png");

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  const svg = readFileSync(srcPath, "utf8");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; }
    html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    svg { display: block; }
  </style></head><body>${svg}</body></html>`;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const chromePath = findChrome();
  const profileDir = mkdtempSync(join(tmpdir(), "layout-lens-promo-"));

  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      `--window-size=${WIDTH},${HEIGHT}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  let page;
  const close = async () => {
    if (page) page.close();
    await new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      child.once("exit", resolve);
      child.kill();
      setTimeout(resolve, 3000);
    });
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`(non-fatal: could not remove ${profileDir}: ${err.message})`);
    }
  };

  try {
    const browserWsUrl = await waitForDevtoolsUrl(child);
    const port = new URL(browserWsUrl).port;
    const httpBase = `http://127.0.0.1:${port}`;

    const created = await fetch(`${httpBase}/json/new?${encodeURIComponent(dataUrl)}`, {
      method: "PUT",
    }).then((r) => r.json());
    page = new CDP(created.webSocketDebuggerUrl);
    await page.ready();
    await waitFor(() => page.evaluate('document.readyState === "complete"'));

    // The window size sets the frame; the override pins the viewport and the
    // pixel ratio, so the capture is 440×280 on any host regardless of the
    // machine's own display scale.
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(150);

    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(data, "base64");
    const { width, height } = pngSize(buf);
    if (width !== WIDTH || height !== HEIGHT) {
      throw new Error(`captured ${width}×${height}, the Store's small tile needs ${WIDTH}×${HEIGHT}`);
    }
    writeFileSync(outPath, buf);
    console.log(`wrote assets/promo/small-tile.png (${width}×${height})`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("Promo tile generation failed:", err);
  process.exit(1);
});
