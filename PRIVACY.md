# Privacy Policy — Layout Lens

Last updated: 2026-09-13

Layout Lens collects no data.

It transmits nothing to any server. It has no analytics, no telemetry, no
crash reporting, no account, and makes no network requests of any kind.

## What it stores

One value: a true/false flag per browser tab recording whether the inspector
is switched on. It is held in `chrome.storage.session`, which exists only in
memory, is never written to disk, and is cleared when you close Chrome.

Nothing else is stored.

## What it reads

While the inspector is active, the extension reads the position, size, and
computed CSS of the element under your cursor, to draw the overlay. Those
values stay in the page, are replaced on the next frame, and are never saved
or sent anywhere.

Pressing `c` copies the current measurement to your clipboard. That is the
only thing the extension ever writes outside its own overlay, and it happens
only on that keypress.

## Permissions

- `activeTab`, granted only when you press the extension's shortcut. It is
  used to message the content script in that tab. No other tab is accessed.
- `storage`, used only for the session flag described above.

The content script is declared on all sites because it has to already be
running in the page when you press the shortcut. Until then it registers a
single extension-message listener and does nothing else: it adds no page
event listeners, reads nothing, and creates no elements. Switching the
inspector off removes everything it added.

## Contact

Questions about this policy: use the developer contact address on the Layout
Lens listing in the Chrome Web Store.
