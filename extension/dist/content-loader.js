// Lightweight loader to import the bundled React paywall content script as an ES module.
(async () => {
  try {
    const url = chrome.runtime.getURL('src/content.js');
    await import(url);
  } catch (error) {
    console.error('TimeWellSpent content loader failed', error);
  }
})();
