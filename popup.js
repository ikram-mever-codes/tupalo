document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["city"], (res) => {
    document.getElementById("cityInput").value = res.city || "berlin";
  });

  setInterval(() => {
    chrome.storage.local.get(
      ["data", "pageIdx", "isPaused", "currentCategoryName", "rateLimitInfo"],
      (res) => {
        document.getElementById("count").innerText = (res.data || []).length;
        document.getElementById("pageIdx").innerText = res.pageIdx || 1;
        document.getElementById("currentCategory").innerText =
          res.currentCategoryName || "None";

        const rl = document.getElementById("rateLimit");
        if (rl) rl.innerText = res.rateLimitInfo || "—";

        let status = res.isPaused ? "PAUSED" : "RUNNING";
        if (!res.isPaused && res.rateLimitInfo)
          status = "⏳ " + res.rateLimitInfo;
        document.getElementById("status").innerText = status;
      },
    );
  }, 1000);

  document.getElementById("startBtn").onclick = () => {
    const city = document.getElementById("cityInput").value;
    chrome.storage.local.set({ isPaused: false, city: city }, () => {
      chrome.runtime.sendMessage({ type: "START_SCRAPE" });
    });
  };

  document.getElementById("pauseBtn").onclick = () => {
    chrome.storage.local.set({ isPaused: true }, () => {
      chrome.runtime.sendMessage({ type: "PAUSE_SCRAPE" });
    });
  };

  document.getElementById("skipBtn").onclick = () => {
    chrome.runtime.sendMessage({ type: "SKIP_CATEGORY" });
  };

  document.getElementById("clearBtn").onclick = () => {
    if (
      confirm("Are you sure you want to delete all scraped database entries?")
    ) {
      chrome.storage.local.set({ data: [] });
    }
  };

  document.getElementById("resetBtn").onclick = () => {
    if (confirm("Reset layout completely back to index conditions?")) {
      chrome.storage.local.set(
        {
          isPaused: true,
          catIdx: 0,
          pageIdx: 1,
          currentCategoryName: "",
          rateLimitInfo: "",
        },
        () => alert("State reset successfully."),
      );
    }
  };

  document.getElementById("downloadBtn").onclick = () => {
    chrome.storage.local.get(["data"], (res) => {
      const rawData = res.data || [];
      const columnOrder = [
        "url",
        "name",
        "status",
        "category",
        "address",
        "town",
        "contact",
        "web",
        "fb",
      ];
      const ws = XLSX.utils.json_to_sheet(rawData, { header: columnOrder });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "TupaloData");
      XLSX.writeFile(wb, `Tupalo_Germany_${Date.now()}.xlsx`);
    });
  };
});
