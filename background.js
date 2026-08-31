// Layout Lens — background service worker (Manifest V3)
//
// Owns the on/off state for each tab and broadcasts it to every frame's content
// script. Keeping the state here — rather than letting each frame flip its own —
// is what keeps a page with iframes consistent: one Alt+S toggles the whole tab,
// and Esc in any frame turns the whole tab off.
//
// The state Map lives only in this worker's memory: no chrome.storage, nothing
// on disk. If the worker is evicted while an inspector is active, the next Alt+S
// may take one extra press to re-sync. That's an accepted trade for keeping the
// extension storage-free.
//
// The `activeTab` permission is granted for the active tab whenever the user
// runs our command, which is what lets `chrome.tabs.sendMessage` reach the
// content scripts without any broad host permissions.

const tabActive = new Map(); // tabId -> boolean

function broadcast(tabId, active) {
  // No `frameId` => delivered to every frame in the tab that has a listener.
  chrome.tabs.sendMessage(tabId, { type: "LAYOUT_LENS_SET", active }, () => {
    // Frames with no content script (chrome://, the PDF viewer, the Web Store,
    // some sandboxed iframes) have no receiver — ignore that error.
    void chrome.runtime.lastError;
  });
}

// Global keyboard shortcut: flip the active tab's state and push it out.
chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-layout-lens") return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || tab.id == null) return;

    const next = !tabActive.get(tab.id);
    tabActive.set(tab.id, next);
    broadcast(tab.id, next);
  });
});

// A content script asks us to turn the whole tab off (the user pressed Esc).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "LAYOUT_LENS_ESC") return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;

  tabActive.set(tabId, false);
  broadcast(tabId, false);
});

// Forget a tab's state when it closes or starts loading a new document — the
// fresh content scripts always come up inactive.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabActive.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") tabActive.delete(tabId);
});
