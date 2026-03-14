/**
 * Live Mode lifecycle states.
 *
 * idle     → starting → live   (user enables Live Mode)
 * live     → stopping → idle   (user disables, or auth failure)
 */
export type LiveModeState = 'idle' | 'starting' | 'live' | 'stopping';

export interface LiveModeStatusEvent {
  state: LiveModeState;
  reason?: string;
}

/**
 * Capacitor plugin contract for the native LiveMode foreground service.
 * Implemented in LiveModePlugin.java.
 */
export interface LiveModePlugin {
  startLiveMode(): Promise<{ state: LiveModeState }>;
  stopLiveMode(): Promise<{ state: LiveModeState }>;
  getLiveModeStatus(): Promise<{ state: LiveModeState }>;
  /** Optional native context hook used by rho-web mobile bridge. */
  setLiveContext?(context: { baseUrl: string; rpcSessionId: string; ttlMs?: number }): Promise<{ ok: boolean; state: LiveModeState }>;
  /** Optional native context hook used by rho-web mobile bridge. */
  clearLiveContext?(): Promise<{ ok: boolean; state: LiveModeState }>;
  addListener(
    event: 'liveModeStatusChanged',
    callback: (event: LiveModeStatusEvent) => void
  ): Promise<{ remove: () => void }> | { remove: () => void };
}

type PreferencesLike = {
  get: (opts: { key: string }) => Promise<{ value: string | null }>;
  set: (opts: { key: string; value: string }) => Promise<void>;
  remove: (opts: { key: string }) => Promise<void>;
};

const PREF_KEY_ENABLED = 'live_mode_enabled';

function createFallbackPreferences(): PreferencesLike {
  const inMemory = new Map<string, string>();

  const storage =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as any).localStorage !== 'undefined'
      ? (globalThis as any).localStorage
      : null;

  return {
    async get({ key }) {
      if (storage && typeof storage.getItem === 'function') {
        try {
          return { value: storage.getItem(key) };
        } catch {
          // Fall through to in-memory fallback.
        }
      }
      return { value: inMemory.get(key) ?? null };
    },
    async set({ key, value }) {
      if (storage && typeof storage.setItem === 'function') {
        try {
          storage.setItem(key, value);
          return;
        } catch {
          // Fall through to in-memory fallback.
        }
      }
      inMemory.set(key, value);
    },
    async remove({ key }) {
      if (storage && typeof storage.removeItem === 'function') {
        try {
          storage.removeItem(key);
          return;
        } catch {
          // Fall through to in-memory fallback.
        }
      }
      inMemory.delete(key);
    },
  };
}

function resolvePreferences(): PreferencesLike {
  const plugins = (globalThis as any)?.Capacitor?.Plugins;
  const preferences = plugins?.Preferences;

  if (
    preferences &&
    typeof preferences.get === 'function' &&
    typeof preferences.set === 'function' &&
    typeof preferences.remove === 'function'
  ) {
    return preferences as PreferencesLike;
  }

  return createFallbackPreferences();
}

/**
 * Attempt to resolve the native LiveMode Capacitor plugin.
 *
 * rho-android runs in a no-build browser runtime where Capacitor plugins are exposed
 * on globalThis.Capacitor.Plugins, not via module imports. Using require/registerPlugin
 * here silently fails in WebView and would fall back to fake local state.
 */
function tryRegisterPlugin(): LiveModePlugin | null {
  const plugin = (globalThis as any)?.Capacitor?.Plugins?.LiveMode;

  if (!plugin || typeof plugin !== 'object') {
    return null;
  }

  const hasRequiredMethods =
    typeof plugin.startLiveMode === 'function' &&
    typeof plugin.stopLiveMode === 'function' &&
    typeof plugin.getLiveModeStatus === 'function' &&
    typeof plugin.addListener === 'function';

  if (!hasRequiredMethods) {
    return null;
  }

  return plugin as LiveModePlugin;
}

/**
 * Controls the Live Mode / Idle Mode lifecycle.
 *
 * Live Mode = Android Foreground Service active; keeps server session alive
 * during lock screen without depending on WebView timer continuity.
 *
 * Idle Mode = no always-on background socket; reconnect resumes
 * when the app becomes active again.
 */
export class LiveModeController {
  private state: LiveModeState = 'idle';
  private readonly listeners: Array<(event: LiveModeStatusEvent) => void> = [];
  private nativeListenerHandle: { remove: () => void } | null = null;

  constructor(
    private readonly plugin: LiveModePlugin | null = tryRegisterPlugin(),
    private readonly preferences: PreferencesLike = resolvePreferences()
  ) {}

  /**
   * Restore state from native plugin + preferences.
   * Call once on app startup before reading getState().
   */
  async initialize(): Promise<void> {
    if (this.plugin) {
      try {
        const status = await this.plugin.getLiveModeStatus();
        this.state = status.state;
      } catch {
        // Plugin unavailable or service not running — default to idle.
        this.state = 'idle';
      }

      // Subscribe to native service lifecycle events.
      try {
        const listenerResult = this.plugin.addListener('liveModeStatusChanged', (event) => {
          this.state = event.state;
          this.emitChange(event);
        });

        if (
          listenerResult &&
          typeof (listenerResult as Promise<unknown>).then === 'function'
        ) {
          (listenerResult as Promise<{ remove: () => void }>)
            .then((handle) => {
              this.nativeListenerHandle = handle;
            })
            .catch(() => {
              /* listener setup failed — operate without events */
            });
        } else if (
          listenerResult &&
          typeof (listenerResult as { remove?: unknown }).remove === 'function'
        ) {
          this.nativeListenerHandle = listenerResult as { remove: () => void };
        }
      } catch {
        /* listener setup failed — operate without events */
      }
    } else {
      // Non-native environment: check persisted preference.
      const { value } = await this.preferences.get({ key: PREF_KEY_ENABLED });
      this.state = value === 'true' ? 'live' : 'idle';
    }
  }

  /**
   * Start Live Mode foreground service.
   * Idempotent: no-op if already live or starting.
   */
  async startLiveMode(): Promise<void> {
    if (this.state === 'live' || this.state === 'starting') return;

    this.applyState('starting');

    if (this.plugin) {
      try {
        const result = await this.plugin.startLiveMode();
        this.applyState(result.state);
        await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'true' });
      } catch (e: unknown) {
        this.applyState('idle', 'start_failed');
        throw e;
      }
    } else {
      // Web/test fallback: simulate transition.
      this.applyState('live');
      await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'true' });
    }
  }

  /**
   * Stop Live Mode foreground service and return to Idle Mode.
   * Idempotent: no-op if already idle or stopping.
   */
  async stopLiveMode(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopping') return;

    this.applyState('stopping');

    if (this.plugin) {
      try {
        const result = await this.plugin.stopLiveMode();
        this.applyState(result.state);
      } catch {
        this.applyState('idle', 'stop_error');
      }
    } else {
      this.applyState('idle');
    }

    await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'false' });
  }

  /**
   * Toggle between Live and Idle modes.
   */
  async toggle(): Promise<void> {
    if (this.state === 'live' || this.state === 'starting') {
      await this.stopLiveMode();
    } else {
      await this.startLiveMode();
    }
  }

  /**
   * Force-stop Live Mode when auth failure occurs.
   * Does not throw; best-effort cleanup.
   */
  async handleAuthFailure(): Promise<void> {
    try {
      await this.stopLiveMode();
    } catch {
      this.applyState('idle', 'auth_failure');
      await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'false' }).catch(() => {});
    }
  }

  getState(): LiveModeState {
    return this.state;
  }

  isLive(): boolean {
    return this.state === 'live';
  }

  /**
   * Subscribe to state change events. Returns an unsubscribe function.
   */
  addListener(cb: (event: LiveModeStatusEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /** Release native listener handle on teardown. */
  destroy(): void {
    if (this.nativeListenerHandle) {
      this.nativeListenerHandle.remove();
      this.nativeListenerHandle = null;
    }
    this.listeners.length = 0;
  }

  private applyState(state: LiveModeState, reason?: string): void {
    this.state = state;
    this.emitChange({ state, reason });
  }

  private emitChange(event: LiveModeStatusEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        /* listener errors must not crash controller */
      }
    }
  }
}
