/**
 * Replay-safe resume primitives for the rho-android mobile shell.
 *
 * Captures session state (sessionId, rpcSessionId, lastEventSeq) from the
 * active rho-web frame before the app backgrounds, then restores it when the
 * app returns to foreground — enabling gap-free, deduplicated stream recovery.
 *
 * PostMessage protocol (mobile shell ↔ rho-web frame):
 *   shell → frame:  { type: 'RHO_CAPTURE_REPLAY' }
 *   frame → shell:  { type: 'RHO_REPLAY_STATE', sessionId, rpcSessionId, lastEventSeq }
 *   shell → frame:  { type: 'RHO_REPLAY_RESUME', sessionId, rpcSessionId, lastEventSeq }
 *
 * For top-level-navigation mode (no iframe), the snapshot is persisted to
 * sessionStorage and reloaded on the next page load; the web UI reads a
 * 'rho:replay-resume' CustomEvent fired after DOMContentLoaded.
 */

export interface ReplaySnapshot {
  sessionId: string;
  rpcSessionId: string;
  lastEventSeq: number;
  capturedAt: number;
}

const STORAGE_KEY = 'rho_replay_snapshot';
const CAPTURE_TIMEOUT_MS = 2000;

/** Normalise raw lastEventSeq values from untrusted message payloads. */
function normalizeSeq(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Manages replay snapshot capture and restore for the mobile shell.
 *
 * Usage:
 *   const rr = new ReplayResume();
 *   rr.mount();                            // start listening for frame responses
 *   const snap = await rr.captureSnapshot(webFrame);
 *   rr.saveSnapshot(snap);                 // persists across page reloads
 *   // ... on resume ...
 *   const snap = rr.loadSnapshot();
 *   rr.emitResumeRequest(webFrame, snap);
 */
export class ReplayResume {
  private pendingCapture: {
    resolve: (snap: ReplaySnapshot | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private messageHandler: ((e: MessageEvent) => void) | null = null;

  constructor(private readonly win: Window = typeof window !== 'undefined' ? window : (globalThis as unknown as Window)) {}

  /**
   * Attach message listener. Call once after DOM is ready.
   */
  mount(): void {
    if (this.messageHandler) return; // idempotent
    this.messageHandler = (e: MessageEvent) => this.handleMessage(e);
    this.win.addEventListener('message', this.messageHandler);
  }

  /**
   * Detach message listener and cancel any pending capture.
   */
  unmount(): void {
    if (this.messageHandler) {
      this.win.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.pendingCapture) {
      clearTimeout(this.pendingCapture.timer);
      this.pendingCapture.resolve(null);
      this.pendingCapture = null;
    }
  }

  /**
   * Request a replay snapshot from the rho-web frame.
   *
   * Sends RHO_CAPTURE_REPLAY and waits up to CAPTURE_TIMEOUT_MS for a
   * RHO_REPLAY_STATE reply. Returns null on timeout or missing frame.
   */
  async captureSnapshot(frame: HTMLIFrameElement | Window | null): Promise<ReplaySnapshot | null> {
    const target = resolveTarget(frame);
    if (!target) return null;

    return new Promise<ReplaySnapshot | null>((resolve) => {
      // Cancel any in-flight capture.
      if (this.pendingCapture) {
        clearTimeout(this.pendingCapture.timer);
        this.pendingCapture.resolve(null);
      }

      const timer = setTimeout(() => {
        this.pendingCapture = null;
        resolve(null);
      }, CAPTURE_TIMEOUT_MS);

      this.pendingCapture = { resolve, timer };

      try {
        target.postMessage({ type: 'RHO_CAPTURE_REPLAY' }, '*');
      } catch {
        clearTimeout(timer);
        this.pendingCapture = null;
        resolve(null);
      }
    });
  }

  /**
   * Persist snapshot to sessionStorage for use across top-level page reload.
   * No-op if sessionStorage is unavailable.
   */
  saveSnapshot(snapshot: ReplaySnapshot | null): void {
    if (!snapshot) return;
    try {
      globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      /* sessionStorage unavailable (e.g., private mode restrictions) */
    }
  }

  /**
   * Load and clear a persisted snapshot. Returns null if none is stored.
   * Single-use: calling this removes the stored entry.
   */
  loadSnapshot(): ReplaySnapshot | null {
    try {
      const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      globalThis.sessionStorage?.removeItem(STORAGE_KEY);
      const parsed = JSON.parse(raw) as Partial<ReplaySnapshot>;
      return {
        sessionId: String(parsed.sessionId ?? ''),
        rpcSessionId: String(parsed.rpcSessionId ?? ''),
        lastEventSeq: normalizeSeq(parsed.lastEventSeq),
        capturedAt: Number(parsed.capturedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Send a resume request to the rho-web frame.
   * The web frame's message handler calls resumeReconnectSessions with the
   * provided sequence context.
   */
  emitResumeRequest(frame: HTMLIFrameElement | Window | null, snapshot: ReplaySnapshot): void {
    const target = resolveTarget(frame);
    if (!target) return;
    try {
      target.postMessage(
        {
          type: 'RHO_REPLAY_RESUME',
          sessionId: snapshot.sessionId,
          rpcSessionId: snapshot.rpcSessionId,
          lastEventSeq: snapshot.lastEventSeq,
        },
        '*'
      );
    } catch {
      /* cross-origin or destroyed frame — ignore */
    }
  }

  private handleMessage(e: MessageEvent): void {
    if (!e.data || e.data.type !== 'RHO_REPLAY_STATE') return;
    if (!this.pendingCapture) return;

    const { sessionId = '', rpcSessionId = '', lastEventSeq = 0 } = e.data as {
      sessionId?: unknown;
      rpcSessionId?: unknown;
      lastEventSeq?: unknown;
    };

    const snapshot: ReplaySnapshot = {
      sessionId: String(sessionId),
      rpcSessionId: String(rpcSessionId),
      lastEventSeq: normalizeSeq(lastEventSeq),
      capturedAt: Date.now(),
    };

    const { resolve, timer } = this.pendingCapture;
    this.pendingCapture = null;
    clearTimeout(timer);
    resolve(snapshot);
  }
}

function resolveTarget(frame: HTMLIFrameElement | Window | null): Window | null {
  if (!frame) return null;
  if ('contentWindow' in frame) {
    return (frame as HTMLIFrameElement).contentWindow;
  }
  return frame as Window;
}
