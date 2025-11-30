console.log('TimeWellSpent content script ready.');

chrome.runtime.onMessage.addListener((message: any, _sender: chrome.runtime.MessageSender, _sendResponse: (response?: any) => void) => {
    if (message.type === 'BLOCK_SCREEN') {
        showBlockScreen(message.payload);
    }
});

async function showBlockScreen(payload: any) {
    // Remove existing overlay if present
    const existing = document.getElementById('tws-block-overlay');
    if (existing) existing.remove();

    // Get status from background
    const status = await chrome.runtime.sendMessage({
        type: 'GET_STATUS',
        payload: { domain: payload.domain }
    });

    const overlay = document.createElement('div');
    overlay.id = 'tws-block-overlay';
    overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  `;

    const container = document.createElement('div');
    container.style.cssText = `
    max-width: 500px;
    padding: 40px;
    text-align: center;
  `;

    // Icon
    const icon = document.createElement('div');
    icon.textContent = '⏸';
    icon.style.cssText = `
    font-size: 80px;
    margin-bottom: 20px;
  `;

    // Title
    const title = document.createElement('h1');
    title.textContent = 'Time Well Spent';
    title.style.cssText = `
    font-size: 32px;
    font-weight: 600;
    margin-bottom: 10px;
  `;

    // Domain
    const domainText = document.createElement('p');
    domainText.textContent = payload.domain;
    domainText.style.cssText = `
    font-size: 20px;
    color: #888;
    margin-bottom: 30px;
  `;

    // Balance
    const balance = document.createElement('div');
    const lastSyncAgo = status.lastSync ? formatTimeSince(status.lastSync) : 'never';
    balance.textContent = `Balance: ${status.balance} f-coins (synced ${lastSyncAgo})`;
    balance.style.cssText = `
    font-size: 16px;
    color: #4CAF50;
    margin-bottom: 30px;
  `;

    container.appendChild(icon);
    container.appendChild(title);
    container.appendChild(domainText);
    container.appendChild(balance);

    if (status.session && status.session.paused) {
        const pausedNote = document.createElement('p');
        pausedNote.textContent = `Session paused • ${status.session.remainingSeconds === Infinity ? 'Metered' : `${Math.round(status.session.remainingSeconds / 60)} min left`}`;
        pausedNote.style.cssText = `
      font-size: 18px;
      color: #ffcf99;
      margin-bottom: 20px;
    `;
        container.appendChild(pausedNote);

        const resumeButton = document.createElement('button');
        resumeButton.textContent = 'Resume spending';
        resumeButton.style.cssText = `
      padding: 12px 20px;
      font-size: 14px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    `;
        resumeButton.onclick = () => resumeSession(payload.domain);
        container.appendChild(resumeButton);

        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Keep paused and close';
        cancelButton.style.cssText = `
      padding: 10px 16px;
      margin-top: 12px;
      font-size: 13px;
      background: transparent;
      color: #ccc;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      cursor: pointer;
    `;
        cancelButton.onclick = () => {
            const overlay = document.getElementById('tws-block-overlay');
            if (overlay) overlay.remove();
            document.body.style.overflow = '';
        };
        container.appendChild(cancelButton);
    } else if (status.desktopConnected && status.rate) {
        // Desktop is running - show purchase options
        const info = document.createElement('p');
        info.textContent = `This site costs ${status.rate.ratePerMin} coins/minute`;
        info.style.cssText = `
      font-size: 18px;
      margin-bottom: 20px;
    `;
        container.appendChild(info);

        // Packs
        const packsContainer = document.createElement('div');
        packsContainer.style.cssText = `
      display: flex;
      gap: 15px;
      justify-content: center;
      margin-bottom: 20px;
    `;

        for (const pack of status.rate.packs) {
            const button = document.createElement('button');
            button.textContent = `${pack.minutes} min (${pack.price} coins)`;
            button.style.cssText = `
        padding: 15px 25px;
        font-size: 16px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.2s;
      `;
            button.onmouseover = () => button.style.background = '#45a049';
            button.onmouseout = () => button.style.background = '#4CAF50';
            button.onclick = () => buyPack(payload.domain, pack.minutes);
            packsContainer.appendChild(button);
        }

        container.appendChild(packsContainer);

        // Pay as you go
        const meteredButton = document.createElement('button');
        meteredButton.textContent = 'Pay as you go';
        meteredButton.style.cssText = `
      padding: 12px 20px;
      font-size: 14px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    `;
        meteredButton.onmouseover = () => meteredButton.style.background = '#0b7dda';
        meteredButton.onmouseout = () => meteredButton.style.background = '#2196F3';
        meteredButton.onclick = () => startMetered(payload.domain);
        container.appendChild(meteredButton);

    } else {
        // Desktop is NOT running - prompt to open it
        const warning = document.createElement('p');
        warning.textContent = '⚠️ Desktop app is not running';
        warning.style.cssText = `
      font-size: 18px;
      color: #ff9800;
      margin-bottom: 20px;
    `;

        const instruction = document.createElement('p');
        instruction.textContent = 'To purchase time, please open the TimeWellSpent desktop app';
        instruction.style.cssText = `
      font-size: 16px;
      color: #ccc;
      margin-bottom: 30px;
    `;

        const hint = document.createElement('p');
        hint.textContent = 'Run: pnpm start';
        hint.style.cssText = `
      font-size: 14px;
      font-family: 'Courier New', monospace;
      background: rgba(255,255,255,0.1);
      padding: 10px;
      border-radius: 4px;
      color: #4CAF50;
    `;

        container.appendChild(warning);
        container.appendChild(instruction);
        container.appendChild(hint);
    }

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    // Prevent scrolling
    document.body.style.overflow = 'hidden';
}

async function buyPack(domain: string, minutes: number) {
    const result = await chrome.runtime.sendMessage({
        type: 'BUY_PACK',
        payload: { domain, minutes }
    });

    if (result.success) {
        // Remove overlay and reload
        const overlay = document.getElementById('tws-block-overlay');
        if (overlay) overlay.remove();
        document.body.style.overflow = '';
        location.reload();
    } else {
        alert(`Failed to purchase: ${result.error}`);
    }
}

async function startMetered(domain: string) {
    const result = await chrome.runtime.sendMessage({
        type: 'START_METERED',
        payload: { domain }
    });

    if (result.success) {
        // Remove overlay and reload
        const overlay = document.getElementById('tws-block-overlay');
        if (overlay) overlay.remove();
        document.body.style.overflow = '';
        location.reload();
    } else {
        alert(`Failed to start metered session: ${result.error}`);
    }
}

async function resumeSession(domain: string) {
    const result = await chrome.runtime.sendMessage({
        type: 'RESUME_SESSION',
        payload: { domain }
    });

    if (result.success) {
        const overlay = document.getElementById('tws-block-overlay');
        if (overlay) overlay.remove();
        document.body.style.overflow = '';
        location.reload();
    } else {
        alert(`Failed to resume: ${result.error}`);
    }
}

function formatTimeSince(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}
