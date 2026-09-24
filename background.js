// Layout Lens — background service worker (Manifest V3)
//
// Owns the on/off state for each tab and broadcasts it to every frame's content
// script. Keeping the state here — rather than letting each frame flip its own —
// is what keeps a page with iframes consistent: one Alt+S toggles the whole tab,
// and Esc in any frame turns the whole tab off.
//
// State lives in chrome.storage.session: memory-only, cleared automatically
// when the browser closes, never touches disk. It replaces what used to be a
// plain in-memory Map — the Map didn't survive MV3 service-worker eviction (an
// idle worker can be killed and restarted at any time), so an evicted worker
// forgot every tab's state and the next Alt+S needed a second press to
// re-sync. storage.session does survive eviction, so the very next press picks
// up correctly. It costs the "storage" permission but no permission prompt is
// shown for it, and nothing here is written to storage.local — the "no
// persistent state" property holds, just scoped to "persistent across worker
// restarts" rather than "in this one variable."
//
// The `activeTab` permission is granted for the active tab whenever the user
// runs our command, which is what lets `chrome.tabs.sendMessage` reach the
// content scripts without any broad host permissions.

function broadcast(tabId, active) {
  // No `frameId` => delivered to every frame in the tab that has a listener.
  chrome.tabs.sendMessage(tabId, { type: "LAYOUT_LENS_SET", active }, () => {
    // Frames with no content script (chrome://, the PDF viewer, the Web Store,
    // some sandboxed iframes) have no receiver — ignore that error.
    void chrome.runtime.lastError;
  });
}

function onActiveTab(fn) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.id != null) fn(tab.id);
  });
}

async function getTabActive(tabId) {
  const store = await chrome.storage.session.get(String(tabId));
  return !!store[tabId];
}

// The toolbar badge mirrors the state: "ON" while the lens is active in that
// tab. Unlike the in-page notice it stays up, and it draws nothing on the
// page. Tab-scoped, so other tabs keep a plain icon. The colour is the
// overlay's blue outline.
chrome.action.setBadgeBackgroundColor({ color: "#4682dc" });
chrome.action.setBadgeTextColor({ color: "#ffffff" });

async function setTabActive(tabId, active) {
  // Storing only "true" entries keeps storage.session from accumulating a
  // key per tab ever opened; an absent key already means false via getTabActive.
  if (active) await chrome.storage.session.set({ [tabId]: true });
  else await chrome.storage.session.remove(String(tabId));
  // Rejects if the tab is already gone; nothing left to update then.
  chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" }).catch(() => {});
}

// Global keyboard shortcuts. Both are rebindable at chrome://extensions/shortcuts
// if Alt+S / Alt+U clash with something.
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-layout-lens") {
    // Flip the active tab's on/off state and push it to every frame.
    onActiveTab(async (tabId) => {
      const next = !(await getTabActive(tabId));
      await setTabActive(tabId, next);
      broadcast(tabId, next);
    });
  } else if (command === "cycle-layout-lens-unit") {
    // Display-only: forwarded to every frame, ignored unless that frame is
    // active. The unit is a plain variable in the content script — no tab
    // state here, nothing persisted.
    onActiveTab((tabId) => {
      chrome.tabs.sendMessage(tabId, { type: "LAYOUT_LENS_CYCLE_UNIT" }, () => {
        void chrome.runtime.lastError;
      });
    });
  }
});

// A content script asks us to turn the whole tab off (the user pressed Esc).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "LAYOUT_LENS_ESC") return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;

  setTabActive(tabId, false).then(() => broadcast(tabId, false));
});

// Forget a tab's state when it closes or starts loading a new document — the
// fresh content scripts always come up inactive, so the badge clears too.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(String(tabId));
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") setTabActive(tabId, false);
});
