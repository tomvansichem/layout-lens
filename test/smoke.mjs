#!/usr/bin/env node
// Layout Lens — smoke test
//
// Guards the things that are easy to silently break: the border-box/transform
// math behind the red mismatch, the clip check, the two advisory lines, and
// that deactivate() really leaves no trace. It drives a real headless Chrome
// over the DevTools Protocol against test/testbed.html.
//
// Deliberately dependency-free, matching the rest of this repo — no
// package.json, no npm install. Uses only Node built-ins (child_process, http
// via fetch, and the global WebSocket/fetch that ship unflagged since Node 22).
// Requires Node 22+ and a Chrome/Chromium binary that still honors
// --load-extension.
//
// Confirmed on Chrome 152: stable-channel Google Chrome silently ignores
// --load-extension (no error, the extension just never appears — verified
// with a trivial unrelated MV3 extension, so this isn't specific to Layout
// Lens). A "Chrome for Testing" build does not have that restriction and is
// otherwise the same engine. Download one matching your Chrome version from
// https://googlechromelabs.github.io/chrome-for-testing/ and point
// CHROME_PATH at the binary inside the .app (or the plain executable on
// Linux/Windows).
//
// Pin a known-good Chrome for Testing version rather than always grabbing
// "latest Stable" — 152.0.7977.82 passes every check below; 153.0.8010.36
// (the very next Stable, tested the same week) loads the extension
// correctly but never injects the content script into any page at all, in
// this exact headless + --load-extension flow. Cause not diagnosed (out of
// scope for this repo); the fix that matters here is picking a build that's
// actually verified to work, not chasing the newest one.
//
// What this does NOT test: the actual Alt+S/Alt+U key bindings. Chrome's
// `commands` API is a browser-chrome-level accelerator, not a page event, and
// there's no CDP hook to simulate it. Instead this talks to the extension's
// own service worker and sends the exact LAYOUT_LENS_SET message
// background.js's broadcast() sends on a real keypress — that exercises the
// real content.js message-handling and measurement code, just not the literal
// key dispatch (which is a one-line, declarative, low-regression-risk path).
//
// Usage:  node test/smoke.mjs
//
// Known fragility: headless Chrome's extension support and remote-debugging
// output format have both shifted across Chrome versions before. If this
// starts failing on Chrome update, check CHROME_PATH's --version first.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const testbedPath = join(repoRoot, "test", "testbed.html");

// Serve testbed.html over http(s) rather than file://. A fresh profile has
// no "Allow access to file URLs" grant for the extension — that's a per-
// profile, persisted toggle a real user sets in chrome://extensions, and
// there's no flag to preset it — so file:// content scripts never inject
// here. http sidesteps that entirely and is the more common real-world path.
function serveTestbed() {
  const html = readFileSync(testbedPath);
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const byPlatform = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  };
  for (const c of byPlatform[process.platform] || []) {
    if (existsSync(c)) return c;
  }
  throw new Error("Chrome not found. Set CHROME_PATH to your Chrome/Chromium binary.");
}

// Chrome prints its DevTools websocket endpoint to stderr once the debugger
// port is actually listening — more reliable than guessing a free port.
function waitForDevtoolsUrl(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        child.stderr.off("data", onData);
        resolve(m[1]);
      }
    };
    child.stderr.on("data", onData);
    // Chrome's own stderr is the only account of why it died. Without it, a
    // sandbox refused by the kernel and a broken binary are the same message.
    child.once("exit", (code, signal) =>
      reject(new Error(`Chrome exited early (code ${code}, signal ${signal})\n${buf.trim()}`))
    );
    setTimeout(() => reject(new Error("Timed out waiting for the DevTools endpoint")), 15000);
  });
}

// Minimal CDP client: one WebSocket, JSON-RPC-style request/response.
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("WebSocket connect failed")), { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error("Evaluate failed: " + JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function waitFor(fn, { timeout = 10000, interval = 200 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition");
    await sleep(interval);
  }
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ""}`);
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
    name: "B5 \u00b7 control, no transform",
    expect: (s) => [
      ["no mismatch", !s.mismatch],
      ["no clip", !s.clip],
      ["no clamp line", !s.tipText.includes("pinned by")],
      ["no viewport-overflow line", !s.tipText.includes("wider than the viewport")],
    ],
  },
  {
    id: "fx-transform",
    name: "B1 \u00b7 transform: scale(0.8)",
    expect: (s) => [
      ["mismatch fires", s.mismatch],
      ["names the cause", s.tipText.includes("transform on this element")],
    ],
  },
  {
    id: "fx-clip",
    name: "B11 \u00b7 overflow:hidden clipping content",
    expect: (s) => [
      ["clip fires", s.clip],
      ["no mismatch", !s.mismatch],
      ["reports clipped content", s.tipText.includes("clipped to")],
    ],
  },
  {
    id: "fx-clamp",
    name: "B9 \u00b7 min-width clamp",
    expect: (s) => [
      ["no mismatch (clamping is invisible to the size check)", !s.mismatch],
      ["names the clamp", s.tipText.includes("pinned by min-width")],
    ],
  },
  {
    id: "fx-vpoverflow",
    name: "D1 \u00b7 wider than the viewport",
    expect: (s) => [
      ["flags viewport overflow", s.tipText.includes("wider than the viewport")],
      ["no mismatch", !s.mismatch],
      ["no clip", !s.clip],
    ],
  },
];

async function main() {
  const chromePath = findChrome();
  const profileDir = mkdtempSync(join(tmpdir(), "layout-lens-smoke-"));
  const server = await serveTestbed();
  const testbedUrl = `http://127.0.0.1:${server.address().port}/`;

  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      `--load-extension=${repoRoot}`,
      `--disable-extensions-except=${repoRoot}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  let browser, page, sw;
  try {
    const browserWsUrl = await waitForDevtoolsUrl(child);
    const port = new URL(browserWsUrl).port;
    const httpBase = `http://127.0.0.1:${port}`;

    // Find OUR extension's service worker target. Chrome loads its own
    // component extensions (Google Network Speech and friends) alongside
    // anything passed to --load-extension, each with its own service_worker
    // target — so picking the first chrome-extension:// hit isn't enough;
    // confirm it by manifest name.
    sw = await waitFor(async () => {
      const list = await fetch(`${httpBase}/json/list`).then((r) => r.json());
      const candidates = list.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
      for (const t of candidates) {
        const probe = new CDP(t.webSocketDebuggerUrl);
        await probe.ready();
        const name = await probe.evaluate("chrome.runtime.getManifest().name").catch(() => null);
        if (name === "Layout Lens") return probe;
        probe.close();
      }
      return null;
    }).catch(() => {
      throw new Error(
        "Layout Lens's service worker never appeared. Most likely cause: this " +
          "Chrome binary is a stable-channel build that silently ignores " +
          "--load-extension (confirmed on Chrome 152) — see the CHROME_PATH " +
          "note at the top of this file for a Chrome for Testing build that " +
          "doesn't have that restriction."
      );
    });
    console.log("Extension service worker found.");

    // Open the testbed in a new tab.
    const created = await fetch(`${httpBase}/json/new?${encodeURIComponent(testbedUrl)}`, {
      method: "PUT",
    }).then((r) => r.json());
    page = new CDP(created.webSocketDebuggerUrl);
    await page.ready();
    await waitFor(() => page.evaluate('document.readyState === "complete"'));
    await sleep(200); // let layout settle

    // Activate the inspector the same way background.js's broadcast() does.
    // Note: without a real command/action gesture, activeTab was never
    // granted, so chrome.tabs.query() would return tabs with url stripped —
    // exactly the permission model doing its job. Selecting by {active:true,
    // currentWindow:true} needs no such access, matching what onActiveTab()
    // in background.js does on a real keypress.
    const tabId = await sw.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab) throw new Error("no active tab found");
      await chrome.tabs.sendMessage(tab.id, { type: "LAYOUT_LENS_SET", active: true });
      return tab.id;
    })()`);
    console.log("Inspector activated.\n");

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
    // Cleanup must never mask the real pass/fail/error above it. child.kill()
    // is a SIGTERM, not a wait — Chrome can still be flushing profile files
    // for a moment after, which raced rmSync into an ENOTEMPTY. Wait for the
    // process to actually exit first, and swallow (don't throw past) any
    // straggling cleanup failure either way.
    if (page) page.close();
    if (sw) sw.close();
    server.close();
    await new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      child.once("exit", resolve);
      child.kill();
      setTimeout(resolve, 3000); // don't hang cleanup forever on a stuck process
    });
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`(non-fatal: could not remove ${profileDir}: ${err.message})`);
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} \u2014 ${failures} failing check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
