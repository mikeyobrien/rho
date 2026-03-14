import { ReplayResume, ReplaySnapshot } from '../src/replay-resume';

class FakeWindowBus {
  private listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('ReplayResume', () => {
  let bus: FakeWindowBus;

  beforeEach(() => {
    bus = new FakeWindowBus();

    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });

    jest.useRealTimers();
  });

  it('captures replay snapshot via postMessage handshake', async () => {
    const rr = new ReplayResume(bus as unknown as Window);
    rr.mount();

    const target = {
      postMessage: jest.fn(),
    } as unknown as Window;

    const promise = rr.captureSnapshot(target);

    expect((target as any).postMessage).toHaveBeenCalledWith(
      { type: 'RHO_CAPTURE_REPLAY' },
      '*',
    );

    bus.emit('message', {
      data: {
        type: 'RHO_REPLAY_STATE',
        sessionId: 's-1',
        rpcSessionId: 'rpc-1',
        lastEventSeq: 42,
      },
    });

    const snapshot = await promise;
    expect(snapshot).toEqual({
      sessionId: 's-1',
      rpcSessionId: 'rpc-1',
      lastEventSeq: 42,
      capturedAt: expect.any(Number),
    });
  });

  it('saveSnapshot/loadSnapshot round-trips and clears stored entry', () => {
    const rr = new ReplayResume(bus as unknown as Window);

    const snapshot: ReplaySnapshot = {
      sessionId: 's-2',
      rpcSessionId: 'rpc-2',
      lastEventSeq: 11,
      capturedAt: Date.now(),
    };

    rr.saveSnapshot(snapshot);

    const first = rr.loadSnapshot();
    expect(first).toEqual(snapshot);

    const second = rr.loadSnapshot();
    expect(second).toBeNull();
  });

  it('emitResumeRequest posts normalized resume payload to target frame', () => {
    const rr = new ReplayResume(bus as unknown as Window);

    const frame = {
      postMessage: jest.fn(),
    } as unknown as Window;

    rr.emitResumeRequest(frame, {
      sessionId: 's-3',
      rpcSessionId: 'rpc-3',
      lastEventSeq: 7,
      capturedAt: 1,
    });

    expect((frame as any).postMessage).toHaveBeenCalledWith(
      {
        type: 'RHO_REPLAY_RESUME',
        sessionId: 's-3',
        rpcSessionId: 'rpc-3',
        lastEventSeq: 7,
      },
      '*',
    );
  });

  it('captureSnapshot times out to null when frame never responds', async () => {
    jest.useFakeTimers();

    const rr = new ReplayResume(bus as unknown as Window);
    rr.mount();

    const target = {
      postMessage: jest.fn(),
    } as unknown as Window;

    const promise = rr.captureSnapshot(target);
    jest.advanceTimersByTime(2100);
    await Promise.resolve();

    await expect(promise).resolves.toBeNull();
  });
});
