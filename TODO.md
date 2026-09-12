# TODO — path to publishing Layout Lens v1.0.0

Tracks everything needed to ship Layout Lens to the Chrome Web Store. Written
so any task can be picked up in a fresh session with no memory of how this
file came to be — read `CLAUDE.md` first for the codebase itself, then this
file for what's left.

Check items off as they're done. Update the "Decisions already made" section
if a decision changes — don't silently drift from it.

## Decisions already made (don't re-litigate these)

- **License:** MIT. Copyright holder: `tomvansichem` (matches `git config
  user.name`; the email on record is `tom@apert.be`).
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

## Task 2 — CI: run the smoke test on every push

- [ ] Add `.github/workflows/smoke.yml`.
- [ ] Steps: checkout → download **Chrome for Testing 152.0.7977.82** pinned
      by exact version (`https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.82/linux64/chrome-linux64.zip`
      for a standard `ubuntu-latest` runner) → set `CHROME_PATH` to the
      extracted binary → `node test/smoke.mjs`. Do not use the
      `last-known-good-versions.json` endpoint to fetch "whatever is current" —
      see the decision above on why that's unsafe.
- [ ] If this pinned version ever needs bumping (e.g. it's pulled from
      storage), re-verify locally with `CHROME_PATH` pointed at the candidate
      build before changing CI — confirm `node test/smoke.mjs` actually goes
      green, don't assume a newer build works.
- [ ] Trigger on push and PR to `main`.
- [ ] Actually push and confirm the Actions run goes green on GitHub — a
      workflow file that's never been run is not verified, don't mark this
      done on the strength of it "looking right."

## Task 3 — Screenshots for the store listing

- [ ] Reuse the CDP client already in `test/smoke.mjs` — either extend that
      file or add `test/screenshots.mjs` that imports/duplicates the small
      `CDP` class.
- [ ] Set a real viewport before capturing (`Emulation.setDeviceMetricsOverride`
      or a fixed `--window-size`) — Chrome Web Store wants 1280×800 or 640×400.
- [ ] Capture at least: B1 (red mismatch + `↳ transform on this element`), B11
      (amber clip), B9 (the new `↳ width pinned by min-width…` advisory), D1
      (the new `↔ …px wider than the viewport…` advisory). Four is plenty; the
      Store allows up to 5.
- [ ] Use `Page.captureScreenshot` (returns base64 PNG) and write the files to
      a local `assets/screenshots/` directory (not shipped in the extension
      package — add it to whatever the eventual store-zip step excludes).
- [ ] Hand the PNGs to the user for a look before anything is uploaded
      anywhere — these are the first thing a stranger sees on the listing.

## Task 4 — Store listing copy + Privacy Practices draft

Save all of this into one working file, e.g. `store-listing.md` at repo root
(clearly a publishing artifact, not part of the shipped extension — exclude it
from the store zip same as `assets/`, `test/`, `tools/`, `CLAUDE.md`,
`TODO.md`, `.claude/`).

- [ ] Short description (≤132 chars, shows in search results).
- [ ] Full listing description — adapt from `README.md`'s opening + "What you
      see" section; the Store description can be longer and more marketing-ish
      than the README, but shouldn't overclaim past what the tool verifiably
      does.
- [ ] Suggested category: Developer Tools.
- [ ] Permission justifications for the Privacy Practices tab:
      - `activeTab`: granted only on the user's own keyboard command; used
        solely to message the content script that's already running in that
        tab. No broader tab access.
      - `storage`: used only for `chrome.storage.session`, to remember each
        tab's on/off toggle across the extension's background worker being
        evicted and restarted by Chrome. Memory-only, cleared when the browser
        closes, never written to disk.
- [ ] Data-collection disclosure answers: the honest answer to every category
      Chrome asks about (personally identifiable info, health info, financial
      info, authentication info, personal communications, location, web
      history, user activity, website content) is **no** — nothing is
      collected, transmitted, or stored beyond the one on/off boolean above.
- [ ] Note whether a privacy-policy URL is required: with zero data collection
      it likely isn't *legally* required, but check the Dashboard's current
      requirements when actually filling this in — policy has shifted before
      and may have shifted again.

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

- `test/smoke.mjs`'s header comment and `CLAUDE.md` Gotcha #5 both explain the
  Chrome-for-Testing requirement in detail — read one of those before
  reinventing that investigation.
- The container-query-awareness feature was discussed and deliberately
  rejected earlier in this project's life; see `CLAUDE.md`'s "Deferred / not
  done" section for the reasoning if it comes up again.
- This file can be deleted once Task 5 is fully checked off and the release
  has shipped — it's a release-tracking artifact, not permanent project
  documentation.
