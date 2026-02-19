import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocketBroadcaster } from '../src/backend/websocket/broadcaster';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];

  send(payload: string) {
    this.sent.push(payload);
  }
}

describe('WebSocket pomodoro contract', () => {
  it('broadcasts pause/resume/break lifecycle events', () => {
    const economy = new EventEmitter();
    const focus = new EventEmitter();
    const pomodoro = new EventEmitter();
    const library = Object.assign(new EventEmitter(), { list: () => [] as unknown[] });

    const broadcaster = new WebSocketBroadcaster({
      economy: economy as any,
      paywall: { pause: () => undefined, resume: () => undefined, endSession: () => null } as any,
      wallet: {} as any,
      focus: focus as any,
      pomodoro: pomodoro as any,
      library: library as any,
      emergency: { start: () => null, recordReview: () => ({ total: 0, kept: 0, notKept: 0 }) } as any,
      handleActivity: () => undefined
    });

    const socket = new FakeSocket();
    broadcaster.handleConnection(socket as any);

    pomodoro.emit('pause', { id: 'p1' });
    pomodoro.emit('resume', { id: 'p1' });
    pomodoro.emit('break', { id: 'p1' });

    const types = socket.sent.map((raw) => JSON.parse(raw).type);
    expect(types).toContain('pomodoro-pause');
    expect(types).toContain('pomodoro-resume');
    expect(types).toContain('pomodoro-break');
  });
});
