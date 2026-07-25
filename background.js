const CATEGORIES = [
  "diverses",
  "restaurant",
  "gesundheit",
  "geschaeft",
  "schoenheit",
  "bildung",
  "finanzdienstleistung",
  "essen-und-trinken",
  "dienstleistung",
  "oeffentlicher-dienst",
  "nachtleben",
  "kunst-und-unterhaltung",
  "auto-und-motor",
  "haustier",
  "reise",
  "freizeit",
];

const MAX_CONCURRENT_TABS = 15; // was 15 — the main reason you got blocked so fast
const TAB_STAGGER_MS = 350; // small gap between opening tabs
const BASE_BACKOFF_MS = 20000; // block lasts ~15s, so 20s base
const MAX_BACKOFF_MS = 120000;
const MAX_LINK_ATTEMPTS = 4;
const MAX_LIST_ATTEMPTS = 5;
const TAB_WATCHDOG_MS = 30000; // a tab that never reports gets force-recovered

let activeTabs = new Map(); // numeric tabId -> { url }
let tabWatchdogs = new Map(); // numeric tabId -> timeoutId
let listTabId = null;
let currentListUrl = null;
let currentRemainingLinks = [];
let linkAttempts = new Map(); // url -> attempts
let isLaunching = false;

let cooldownActive = false;
let cooldownTimer = null;
let pendingListReload = false;
let consecutiveBlocks = 0;
let listAttempts = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) resolve(null);
      else resolve(tab);
    });
  });
}

// ---- Watchdog: never let a single stuck tab freeze the run ----
function armWatchdog(tabId, url) {
  clearWatchdog(tabId);
  const t = setTimeout(() => {
    if (!activeTabs.has(tabId)) return;
    console.warn(
      `[Scraper] Watchdog recovering unresponsive tab ${tabId}: ${url}`,
    );
    chrome.tabs.remove(tabId).catch(() => {});
    activeTabs.delete(tabId);
    requeueLink(url);
    postTabDrop();
  }, TAB_WATCHDOG_MS);
  tabWatchdogs.set(tabId, t);
}
function clearWatchdog(tabId) {
  const t = tabWatchdogs.get(tabId);
  if (t) {
    clearTimeout(t);
    tabWatchdogs.delete(tabId);
  }
}

function requeueLink(url, toFront = false) {
  if (!url) return;
  const attempts = (linkAttempts.get(url) || 0) + 1;
  if (attempts <= MAX_LINK_ATTEMPTS) {
    linkAttempts.set(url, attempts);
    if (toFront) currentRemainingLinks.unshift(url);
    else currentRemainingLinks.push(url);
  } else {
    console.error(`[Scraper] Dropping link after ${attempts} attempts: ${url}`);
    linkAttempts.delete(url);
  }
}

// ---- Global cooldown: whole pipeline backs off together ----
function enterCooldown(reason) {
  if (cooldownActive) return; // already cooling — don't stack
  cooldownActive = true;
  consecutiveBlocks += 1;
  const backoff = Math.min(BASE_BACKOFF_MS * consecutiveBlocks, MAX_BACKOFF_MS);
  chrome.storage.local.set({
    rateLimitInfo: `Rate limited — waiting ${Math.round(backoff / 1000)}s`,
  });
  console.warn(
    `[Scraper] Rate limit (${reason}); backing off ${backoff}ms (#${consecutiveBlocks})`,
  );
  cooldownTimer = setTimeout(() => {
    cooldownActive = false;
    cooldownTimer = null;
    chrome.storage.local.set({ rateLimitInfo: "" });
    resumeAfterCooldown();
  }, backoff);
}

function cancelCooldown() {
  if (cooldownTimer) clearTimeout(cooldownTimer);
  cooldownTimer = null;
  cooldownActive = false;
  pendingListReload = false;
  chrome.storage.local.set({ rateLimitInfo: "" });
}

async function resumeAfterCooldown() {
  const { isPaused } = await chrome.storage.local.get(["isPaused"]);
  if (isPaused) return;

  if (pendingListReload) {
    pendingListReload = false;
    reloadOrCreateListTab();
    return;
  }
  if (currentRemainingLinks.length > 0) {
    launchNextBatch();
  } else if (activeTabs.size === 0) {
    const { maxPages } = await chrome.storage.local.get(["maxPages"]);
    advanceToNextPageOrCategory(maxPages || 1);
  }
}

// ---- Messages ----
chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab ? sender.tab.id : null;
  switch (message.type) {
    case "START_SCRAPE":
      cancelCooldown();
      chrome.storage.local.set({ isPaused: false }, () => startLogic());
      break;
    case "PAUSE_SCRAPE":
      cancelCooldown();
      chrome.storage.local.set({ isPaused: true });
      break;
    case "SKIP_CATEGORY":
      skipCurrentCategory();
      break;
    case "LIST_LINKS_READY":
      if (listTabId && tabId === listTabId) {
        processDetailLinks(message.links, message.totalPages);
      }
      break;
    case "DETAIL_DATA_READY":
      handleFinalData(message.payload, tabId);
      break;
    case "DETAIL_DATA_FAILED":
      handleDetailFailed(tabId);
      break;
    case "RATE_LIMIT_HIT":
      if (tabId != null && tabId === listTabId) handleListRateLimit();
      else handleDetailRateLimit(tabId);
      break;
  }
  return true;
});

// ---- Start / list handling ----
async function startLogic() {
  const state = await chrome.storage.local.get([
    "city",
    "catIdx",
    "pageIdx",
    "isPaused",
  ]);
  if (state.isPaused) return;

  let catIdx = state.catIdx !== undefined ? state.catIdx : 0;
  let pageIdx = state.pageIdx || 1;
  const city = state.city || "berlin";

  if (catIdx >= CATEGORIES.length) {
    chrome.storage.local.set({ isPaused: true, currentCategoryName: "DONE ✓" });
    if (listTabId != null) {
      chrome.tabs.remove(listTabId).catch(() => {});
      listTabId = null;
    }
    return;
  }

  const currentCategory = CATEGORIES[catIdx];
  await chrome.storage.local.set({
    currentCategoryName: currentCategory,
    catIdx,
    pageIdx,
  });

  currentListUrl = `https://www.tupalo.de/${city}/c/${currentCategory}?page=${pageIdx}`;
  listAttempts = 0;
  reloadOrCreateListTab();
}

function reloadOrCreateListTab() {
  if (!currentListUrl) {
    startLogic();
    return;
  }
  if (listTabId != null) {
    chrome.tabs.update(listTabId, { url: currentListUrl }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        listTabId = null;
        createListTab(currentListUrl);
      }
    });
  } else {
    createListTab(currentListUrl);
  }
}

function createListTab(url) {
  chrome.tabs.create({ url, active: false }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      setTimeout(() => createListTab(url), 1000);
      return;
    }
    listTabId = tab.id;
  });
}

function handleListRateLimit() {
  listAttempts += 1;
  if (listAttempts > MAX_LIST_ATTEMPTS) {
    console.error("[Scraper] List page blocked too many times; skipping page.");
    listAttempts = 0;
    cancelCooldown();
    chrome.storage.local
      .get(["maxPages"])
      .then((s) => advanceToNextPageOrCategory(s.maxPages || 1));
    return;
  }
  pendingListReload = true;
  enterCooldown("list");
}

async function processDetailLinks(links, totalPages) {
  listAttempts = 0;
  consecutiveBlocks = 0; // we got through the list, reset the streak
  await chrome.storage.local.set({ maxPages: totalPages || 1 });

  if (!links || links.length === 0) {
    advanceToNextPageOrCategory(totalPages || 1);
    return;
  }

  currentRemainingLinks = [...new Set(links)]; // de-dupe
  linkAttempts.clear();
  launchNextBatch();
}

// ---- Detail batch launching (staggered, concurrency-capped) ----
async function launchNextBatch() {
  if (isLaunching) return;
  isLaunching = true;
  try {
    while (true) {
      const { isPaused } = await chrome.storage.local.get(["isPaused"]);
      if (isPaused || cooldownActive) break;
      if (activeTabs.size >= MAX_CONCURRENT_TABS) break;
      if (currentRemainingLinks.length === 0) break;

      const link = currentRemainingLinks.shift();
      const tab = await createTab(link);
      if (tab && tab.id != null) {
        activeTabs.set(tab.id, { url: link });
        armWatchdog(tab.id, link);
      } else {
        currentRemainingLinks.unshift(link);
        await sleep(600);
      }
      await sleep(TAB_STAGGER_MS);
    }
  } finally {
    isLaunching = false;
  }
}

// ---- Per-tab outcomes ----
async function handleFinalData(payload, tabId) {
  clearWatchdog(tabId);
  const info = activeTabs.get(tabId);
  if (info) linkAttempts.delete(info.url);
  consecutiveBlocks = 0;

  const res = await chrome.storage.local.get(["data"]);
  const masterData = res.data || [];
  masterData.push(payload);
  await chrome.storage.local.set({ data: masterData });

  chrome.tabs.remove(tabId).catch(() => {});
  activeTabs.delete(tabId);
  postTabDrop();
}

function handleDetailFailed(tabId) {
  clearWatchdog(tabId);
  const info = activeTabs.get(tabId);
  if (info) linkAttempts.delete(info.url); // genuine failure — don't retry forever
  chrome.tabs.remove(tabId).catch(() => {});
  activeTabs.delete(tabId);
  postTabDrop();
}

function handleDetailRateLimit(tabId) {
  if (tabId == null) {
    enterCooldown("detail");
    return;
  }
  clearWatchdog(tabId);
  const info = activeTabs.get(tabId);
  const url = info ? info.url : null;

  chrome.tabs.remove(tabId).catch(() => {});
  activeTabs.delete(tabId);

  requeueLink(url, true); // retry this one first after the cooldown
  enterCooldown("detail");
}

function postTabDrop() {
  if (cooldownActive) return; // resumeAfterCooldown will handle it
  chrome.storage.local.get(["isPaused", "maxPages"]).then((state) => {
    if (state.isPaused) return;
    if (currentRemainingLinks.length > 0) {
      launchNextBatch();
    } else if (activeTabs.size === 0) {
      advanceToNextPageOrCategory(state.maxPages || 1);
    }
  });
}

// ---- Navigation ----
async function advanceToNextPageOrCategory(maxPages) {
  const state = await chrome.storage.local.get([
    "pageIdx",
    "catIdx",
    "isPaused",
  ]);
  if (state.isPaused) return;

  let pageIdx = state.pageIdx || 1;
  let catIdx = state.catIdx || 0;

  if (pageIdx >= maxPages) {
    catIdx += 1;
    pageIdx = 1;
  } else {
    pageIdx += 1;
  }

  await chrome.storage.local.set({ pageIdx, catIdx });
  startLogic();
}

async function skipCurrentCategory() {
  const state = await chrome.storage.local.get(["catIdx"]);
  const catIdx = (state.catIdx || 0) + 1;

  currentRemainingLinks = [];
  linkAttempts.clear();
  for (const [tabId] of activeTabs) {
    clearWatchdog(tabId);
    if (typeof tabId === "number") chrome.tabs.remove(tabId).catch(() => {});
  }
  activeTabs.clear();
  cancelCooldown();
  consecutiveBlocks = 0;

  await chrome.storage.local.set({ catIdx, pageIdx: 1, maxPages: 1 });
  startLogic();
}
