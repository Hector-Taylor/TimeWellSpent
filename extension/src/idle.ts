// Idle state management module
import { storage } from './storage';
import type { IdleState } from './constants';

let idleState: IdleState = 'active';
let lastIdleChange = Date.now();

export function getIdleState(): IdleState {
    return idleState;
}

export function getIdleSeconds(): number {
    return idleState === 'active' ? 0 : Math.floor((Date.now() - lastIdleChange) / 1000);
}

export async function hydrateIdleState(): Promise<void> {
    const threshold = await storage.getIdleThreshold();
    chrome.idle.setDetectionInterval(threshold);

    chrome.idle.queryState(threshold, (state) => {
        idleState = state as IdleState;
        if (state === 'active') {
            lastIdleChange = Date.now();
        }
    });

    chrome.idle.onStateChanged.addListener((state) => {
        idleState = state as IdleState;
        if (state === 'active') {
            lastIdleChange = Date.now();
        }
    });

    // Listen for storage changes to update threshold
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.state && changes.state.newValue) {
            const newState = changes.state.newValue as { settings?: { idleThreshold?: number } };
            const oldState = changes.state.oldValue as { settings?: { idleThreshold?: number } } | undefined;

            const newThreshold = newState.settings?.idleThreshold;
            const oldThreshold = oldState?.settings?.idleThreshold;

            if (newThreshold && newThreshold !== oldThreshold) {
                console.log('Updating idle threshold to', newThreshold);
                chrome.idle.setDetectionInterval(newThreshold);
            }
        }
    });
}
