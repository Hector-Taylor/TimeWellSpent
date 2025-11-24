// Placeholder background worker. In a full implementation this file would fetch
// active paywall passes from http://localhost:17600 and maintain a dynamic
// declarativeNetRequest allowlist. For now it simply logs installation.
chrome.runtime.onInstalled.addListener(() => {
  console.log('TimeWellSpent extension scaffold installed.');
});
