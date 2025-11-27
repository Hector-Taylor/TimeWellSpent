console.log('TimeWellSpent content script ready.');

chrome.runtime.onMessage.addListener((message: any, _sender: chrome.runtime.MessageSender, _sendResponse: (response?: any) => void) => {
    if (message.type === 'BLOCK_SCREEN') {
        showBlockScreen(message.payload);
    }
});

function showBlockScreen(payload: any) {
    if (document.getElementById('tws-block-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'tws-block-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.95)';
    overlay.style.zIndex = '2147483647'; // Max z-index
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.color = 'white';
    overlay.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

    const title = document.createElement('h1');
    title.textContent = `Time Well Spent: ${payload.domain}`;
    title.style.marginBottom = '20px';

    const msg = document.createElement('p');
    msg.textContent = 'This site is blocked. Pay to proceed.';
    msg.style.fontSize = '18px';

    overlay.appendChild(title);
    overlay.appendChild(msg);
    document.body.appendChild(overlay);

    // Prevent scrolling
    document.body.style.overflow = 'hidden';
}
