# TODO — path to publishing Layout Lens v1.0.0

Tracks everything needed to ship Layout Lens to the Chrome Web Store. Written
so any task can be picked up in a fresh session with no memory of how this
file came to be — read `CLAUDE.md` first for the codebase itself, then this
file for what's left.

Check items off as they're done. Update the "Decisions already made" section
if a decision changes — don't silently drift from it.

## Decisions already made (don't re-litigate these)

- **License:** MIT. Copyright holder: `tomvansichem` (matches `git config
  user.name`).
- **Version:** cutting a clean `1.0.0`, not staying on a beta label. Rationale:
  the smoke test (`test/smoke.mjs`) passes end-to-end, the service-worker
  eviction bug is fixed (`chrome.storage.session`), and the feature set held
  stable across the session that built it.
- **Screenshots** for the store listing get generated through the CDP
  smoke-test harness against `test/testbed.html` — not staged by hand — so
  they show the real overlay, not a mockup.
- **CI** runs the smoke test via GitHub Actions, fetching a Chrome for Testing
  build. Stable-channel Chrome silently ignores `--load-extension` (confirmed
  on Chrome 152 — see `CLAUDE.md` Gotcha #5), so CI must not rely on
  `apt-get install google-chrome` or similar; it needs a Chrome for Testing
  binary specifically, same as local runs need `CHROME_PATH` set to one.
- **Pin a specific, verified Chrome for Testing version — do not fetch
  "latest Stable" dynamically.** Confirmed this session: 152.0.7977.82 passes
  the full smoke test; 153.0.8010.36, the very next Stable release, loads the
  extension correctly but never injects the content script into any page (a
  Chrome-side issue, not diagnosed further, not a Layout Lens bug — see
  `CLAUDE.md` Gotcha #6). A workflow that always grabs "latest" will
  eventually break on a Chrome release for reasons that have nothing to do
  with this repo's code, and the failure will look like a real regression.
- **Do not merge the release PR without the user's explicit go-ahead.** Open
  it for review and stop there — publishing/merging is the user's call.
- **Do not actually submit anything to the Chrome Web Store** — the developer
  account, payment, and submission are user-only actions (task 5).

## Task 1 — Repo housekeeping, commit, PR — ✅ done

- [x] Added `LICENSE` at repo root (MIT, copyright `tomvansichem`, 2026).
- [x] `manifest.json`: bumped `"version"` to `"1.0.0"`; removed
      `"version_name"` entirely.
- [x] `manifest.json`: added `"homepage_url": "https://github.com/tomvansichem/layout-lens"`.
- [x] `README.md`: status line and "Known limitations" heading both dropped
      the beta framing.
- [x] Confirmed via grep that no other `0.9.0`/`0.10.0`/"beta" references
      remained outside this file's own task descriptions.
- [x] Committed as two commits on `feat/unit-toggle`:
      `f9604fe` (eviction fix, popup, two new advisory checks, smoke test,
      version bump + homepage_url, doc updates) and `9ab95ce` (LICENSE +
      this TODO.md).
- [x] Pushed `feat/unit-toggle` with `-u` (no upstream existed before).
- [x] Opened **https://github.com/tomvansichem/layout-lens/pull/1** — summary
      covers the eviction fix, popup, two new checks, smoke test, v1.0.0 cut,
      and a callback to the container-query-awareness rejection.
- [x] Did not merge — left for review, as decided.

## Task 2 — CI: run the smoke test on every push — ✅ done

- [x] Added `.github/workflows/smoke.yml`.
- [x] Steps: checkout → Node 22 → download **Chrome for Testing 152.0.7977.82**
      pinned by exact version → set `CHROME_PATH` to the extracted binary →
      `node test/smoke.mjs`. The version is a literal in the workflow's `env`;
      the `last-known-good-versions.json` endpoint is deliberately not used.
- [x] The "re-verify before bumping" instruction now lives in the workflow's own
      header comment, where whoever edits `CHROME_VERSION` will read it.
- [x] Triggers on push to `main` and PRs targeting `main`. No trigger on pushes
      to feature branches — a PR branch would otherwise run twice per push.
- [x] **One fix was needed to get it green.** Ubuntu 24.04 blocks unprivileged
      user namespaces via AppArmor, which is what Chrome's sandbox needs to
      start; Chrome died on launch before the debugger port opened. The workflow
      now runs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
      before Chrome. `--no-sandbox` would also have worked, but it's a flag
      inside `smoke.mjs`'s hardcoded argv, and weakening the sandbox for every
      local run to fix one CI kernel is the wrong trade.
- [x] Same commit: `waitForDevtoolsUrl`'s early-exit error now includes the
      signal and Chrome's captured stderr. It previously reported only
      `Chrome exited early (code null)`, which is indistinguishable between a
      refused sandbox, a bad binary, and a missing shared library.
- [x] Confirmed green on GitHub: run `34719254704` on `feat/unit-toggle`, all
      15 checks passing, `PASS — 0 failing check(s)`.

## Task 3 — Screenshots for the store listing — ✅ done

- [x] Extracted the Chrome-wrangling out of `test/smoke.mjs` into
      `test/harness.mjs` (`CDP`, `waitFor`, the testbed http server, and
      `startInspector()` — Chrome up, extension loaded, testbed open, inspector
      on, plus its `close()`). `smoke.mjs` is now its checks and nothing else;
      `test/screenshots.mjs` imports the same harness. Duplicating ~150 lines
      was the alternative and it would have drifted.
- [x] `Emulation.setDeviceMetricsOverride` at 1280×800, `deviceScaleFactor: 1`
      (plus `--window-size`), and `Emulation.setEmulatedMedia` forcing
      `prefers-color-scheme: light` — `testbed.html` is theme-aware and the
      machine running the capture shouldn't decide what the listing looks like.
      Each PNG's own IHDR is checked before it's written; an image that came
      back at the host's pixel ratio would otherwise only fail at upload.
- [x] Five shots, in listing order: A1 padding/margin rings (the tool's
      everyday state — worth the hero slot, and the Store allows 5), B1 red
      mismatch + cause, B11 amber clip, B9 clamp advisory, D1 viewport-overflow
      advisory. A1 needed an `id="fx-padding"` in `testbed.html`.
- [x] Written to `assets/screenshots/` — already on Task 4's exclusion list.
- [x] **Two bugs the first run shipped silently, both now fixed and guarded.**
      Real hit-testing (`Input.dispatchMouseEvent`, unlike smoke.mjs's synthetic
      dispatch) put the cursor at B11's centre, which is B11's *child* — a
      perfectly plausible screenshot measuring the wrong element, no warning
      shown. Each capture now asserts the tooltip's selector line names the
      fixture. And `scrollIntoView` on D1 left the page scrolled sideways, which
      read as a broken layout; the script now resets `scrollLeft` so D1 visibly
      runs off the right edge instead.
- [x] Hand the PNGs to the user for a look before anything is uploaded
      anywhere — these are the first thing a stranger sees on the listing.

## Task 4 — Store listing copy + Privacy Practices draft — ✅ done

All of it lives in `store-listing.md` at repo root, written to be pasted into
the Dashboard field by field. Its own header names it a publishing artifact and
lists the store-zip exclusions (`assets/`, `test/`, `tools/`, `CLAUDE.md`,
`TODO.md`, `.claude/`, `.github/`, `LICENSE`, `README.md`, and itself).

- [x] Short description: 115 chars, under the 132 limit. Two alternates kept
      in the file rather than discarded — the choice between them is a taste
      call that's cheaper to make while looking at the listing.
- [x] Full listing description, adapted from `README.md`'s opening and "What
      you see". Four flagged conditions, the key table, an explicit "what it
      doesn't do", and the limitations stated in the listing itself rather than
      left for a reviewer to find. Nothing claims behaviour the code lacks.
- [x] Category: Developer Tools.
- [x] Permission justifications for `activeTab` and `storage`, plus the
      remote-code answer (no — no remote scripts, no eval, no deps).
- [x] Data-collection disclosure: **no** to all nine categories, with a written
      note on why "website content" is still no (computed styles are read in
      the page, rendered to the overlay, discarded next frame; `c` writes to
      the user's own clipboard on an explicit keypress).
- [x] Screenshot captions, one per PNG, in listing order.
- [x] Single-purpose statement.
- [x] Privacy-policy question answered and **checked against Google's own docs
      this session**, not from memory: the [User Data FAQ][t4faq] requires a
      policy only for extensions that *handle user data*, so Layout Lens
      arguably doesn't need one. Recommendation in the file is to publish one
      anyway — it requests `storage`, and a reviewer who reads the permission
      list before the justification is a cheap failure to avoid. A ready-to-use
      `PRIVACY.md` draft is included. The file also says plainly that the
      Dashboard is the authority and to re-check at fill-in time.

[t4faq]: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq

## Task 5 — User-only actions (cannot be done from here)

- [ ] Register a Chrome Web Store Developer Dashboard account ($5 one-time fee).
- [ ] Create the listing; paste in `store-listing.md`'s copy; upload the
      screenshots from Task 3 and the existing `icons/` set (revisit icon
      polish first if it still reads as "minimal generated art" — README used
      to flag this explicitly).
- [ ] Complete the Privacy Practices tab using Task 4's drafted justifications.
- [ ] Submit for review.
- [ ] Merge the release PR from Task 1 whenever ready — not gated on Store
      approval, but doing it after review feels safer than before.

## Context notes for whoever resumes this

- `test/harness.mjs`'s header comment and `CLAUDE.md` Gotcha #5 both explain the
  Chrome-for-Testing requirement in detail — read one of those before
  reinventing that investigation.
- The container-query-awareness feature was discussed and deliberately
  rejected earlier in this project's life; see `CLAUDE.md`'s "Deferred / not
  done" section for the reasoning if it comes up again.
- This file can be deleted once Task 5 is fully checked off and the release
  has shipped — it's a release-tracking artifact, not permanent project
  documentation.
