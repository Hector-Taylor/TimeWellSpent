// Types defined locally to avoid import issues


type ActivityPayload = {
    timestamp: string; // ISO string
    source: 'url';
    appName: string; // 'Google Chrome', 'Arc', etc.
    bundleId?: string;
    windowTitle: string;
    url: string;
    domain: string;
    idleSeconds: number;
};

const WS_URL = 'ws://localhost:17600/events';
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function connect() {
    if (ws) return;

    console.log('Connecting to TimeWellSpent desktop...');
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('Connected to desktop app');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };

    ws.onclose = () => {
        console.log('Disconnected from desktop app');
        ws = null;
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        ws = null; // onclose will trigger
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        } catch (e) {
            console.error('Failed to parse WS message', e);
        }
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 5000);
}

function handleServerMessage(data: any) {
    console.log('Received from server:', data);
    if (data.type === 'paywall-required') {
        // Notify content script of active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (activeTab?.id && activeTab.url && activeTab.url.includes(data.payload.domain)) {
                chrome.tabs.sendMessage(activeTab.id, { type: 'BLOCK_SCREEN', payload: data.payload });
            }
        });
    }
}

// Track active tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    reportActivity(tab);
});

// Track URL updates
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
        reportActivity(tab);
    }
});

function reportActivity(tab: chrome.tabs.Tab) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!tab.url || !tab.url.startsWith('http')) return;

    try {
        const url = new URL(tab.url);
        const domain = url.hostname.replace(/^www\./, '');

        const payload: ActivityPayload = {
            timestamp: new Date().toISOString(),
            source: 'url',
            appName: 'Chrome Extension', // TODO: Detect browser?
            windowTitle: tab.title || '',
            url: tab.url,
            domain: domain,
            idleSeconds: 0 // We can't easily detect idle time here yet
        };

        ws.send(JSON.stringify({ type: 'activity', payload }));
    } catch (e) {
        // Ignore invalid URLs
    }
}

// Initial connect
connect();

// Keep alive
chrome.runtime.onStartup.addListener(connect);
