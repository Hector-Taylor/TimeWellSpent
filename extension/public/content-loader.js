// Lightweight loader to import the bundled React paywall content script as an ES module.
(async () => {
  const bootKey = '__tws_content_module_loaded__';
  if (globalThis[bootKey]) {
    return;
  }
  globalThis[bootKey] = true;
  try {
    const url = chrome.runtime.getURL('src/content.js');
    await import(url);
  } catch (error) {
    globalThis[bootKey] = false;
    console.error('TimeWellSpent content loader failed', error);
  }
})();
