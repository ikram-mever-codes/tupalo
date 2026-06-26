(function () {
  // --- Rate-limit detection (re-checkable, not one-shot) ---
  function isRateLimited() {
    const t = (document.body ? document.body.innerText : "").toLowerCase();
    return (
      t.includes("retry later") ||
      t.includes("too many requests") ||
      t.includes("security verification") ||
      t.includes("429 ") ||
      t.includes("rate limit")
    );
  }

  // Resolves to "found" | "blocked" | "timeout".
  // Keeps watching so a block that renders LATE is still caught.
  function waitForElementOrBlock(selector, timeout) {
    return new Promise((resolve) => {
      if (isRateLimited()) return resolve("blocked");
      if (document.querySelector(selector)) return resolve("found");
      let elapsed = 0;
      const interval = setInterval(() => {
        elapsed += 400;
        if (isRateLimited()) {
          clearInterval(interval);
          resolve("blocked");
        } else if (document.querySelector(selector)) {
          clearInterval(interval);
          resolve("found");
        } else if (timeout > 0 && elapsed >= timeout) {
          clearInterval(interval);
          resolve("timeout");
        }
      }, 400);
    });
  }

  // --- Routing ---
  if (isRateLimited()) {
    chrome.runtime.sendMessage({ type: "RATE_LIMIT_HIT" });
    return;
  }

  if (
    window.location.href.includes("?page=") ||
    window.location.href.includes("/c/") ||
    document.querySelector('div[role="navigation"]')
  ) {
    scrapeListPage();
  } else {
    scrapeDetailPage();
  }

  async function scrapeListPage() {
    const result = await waitForElementOrBlock(
      ".ais-Highlight, a.link[data-client-handler]",
      15000, // FINITE timeout — this is the main fix for the infinite hang
    );

    if (result === "blocked") {
      chrome.runtime.sendMessage({ type: "RATE_LIMIT_HIT" });
      return;
    }
    if (result === "timeout") {
      if (isRateLimited()) {
        chrome.runtime.sendMessage({ type: "RATE_LIMIT_HIT" });
      } else {
        // Genuinely empty/slow page — report empty so background advances
        chrome.runtime.sendMessage({
          type: "LIST_LINKS_READY",
          links: [],
          totalPages: 1,
        });
      }
      return;
    }

    // result === "found": let the list settle, then extract
    await new Promise((r) => setTimeout(r, 1200));

    if (isRateLimited()) {
      chrome.runtime.sendMessage({ type: "RATE_LIMIT_HIT" });
      return;
    }

    const links = Array.from(
      document.querySelectorAll('a.link[data-client-handler="false"]'),
    )
      .map((a) => a.href)
      .filter(
        (href) => href && !href.includes("/c/") && !href.includes("?page="),
      );

    let totalPages = 1;
    const navLinks = Array.from(
      document.querySelectorAll('a[aria-label*="page" i]'),
    );
    const pageNumbers = [];

    navLinks.forEach((link) => {
      const label = link.getAttribute("aria-label") || "";
      const href = link.getAttribute("data-href") || link.href || "";
      const text = link.innerText.trim();

      const labelMatch = label.match(/\d+/);
      if (labelMatch) pageNumbers.push(parseInt(labelMatch[0], 10));

      const hrefMatch = href.match(/page=(\d+)/);
      if (hrefMatch) pageNumbers.push(parseInt(hrefMatch[1], 10));

      const textMatch = text.match(/^\d+$/);
      if (textMatch) pageNumbers.push(parseInt(textMatch[0], 10));
    });

    if (pageNumbers.length > 0) {
      totalPages = Math.max(...pageNumbers);
    }

    chrome.runtime.sendMessage({ type: "LIST_LINKS_READY", links, totalPages });
  }

  async function scrapeDetailPage() {
    const result = await waitForElementOrBlock("#spot-card", 12000);

    if (result === "blocked") {
      chrome.runtime.sendMessage({ type: "RATE_LIMIT_HIT" });
      return;
    }
    if (result === "timeout") {
      if (isRateLimited()) {
        chrome.runtime.sendMessage({ type: "RATE_LIMIT_HIT" });
      } else {
        chrome.runtime.sendMessage({
          type: "DETAIL_DATA_FAILED",
          url: window.location.href,
        });
      }
      return;
    }

    const contacts = [];
    document.querySelectorAll('a[href^="tel:"]').forEach((link) => {
      const number = link.innerText.trim();
      if (number && !contacts.includes(number)) {
        contacts.push(number);
      }
    });

    const addressBlock = document.querySelector("address");
    const addressLines = addressBlock
      ? addressBlock.innerText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

    let parsedTown = addressLines[1] || "";
    if (parsedTown.toLowerCase().includes("deutschland")) {
      parsedTown = parsedTown.replace(/,?\s*Deutschland/i, "").trim();
    }

    const data = {
      url: window.location.href,
      name: document.querySelector("#title h1")?.innerText.trim() || "",
      status: document.querySelector(".bg-tupalo-dark-gold")
        ? "Premium"
        : "Free",
      category: document.querySelector("dl dd .fw6")?.innerText.trim() || "",
      address: addressLines[0] || "",
      town: parsedTown,
      contact: contacts[0] || "",
      web:
        document.querySelector('a[href*="website"]')?.href ||
        document.querySelector(".bg-website")?.closest("a")?.href ||
        "",
      fb: document.querySelector('a[href*="facebook.com"]')?.href || "",
    };

    chrome.runtime.sendMessage({ type: "DETAIL_DATA_READY", payload: data });
  }
})();
