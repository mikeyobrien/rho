const PREF_KEY_ENABLED = 'live_mode_enabled';
function createFallbackPreferences() {
    const inMemory = new Map();
    const storage = typeof globalThis !== 'undefined' &&
        typeof globalThis.localStorage !== 'undefined'
        ? globalThis.localStorage
        : null;
    return {
        async get({ key }) {
            if (storage && typeof storage.getItem === 'function') {
                try {
                    return { value: storage.getItem(key) };
                }
                catch {
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
                }
                catch {
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
                }
                catch {
                    // Fall through to in-memory fallback.
                }
            }
            inMemory.delete(key);
        },
    };
}
function resolvePreferences() {
    const plugins = globalThis?.Capacitor?.Plugins;
    const preferences = plugins?.Preferences;
    if (preferences &&
        typeof preferences.get === 'function' &&
        typeof preferences.set === 'function' &&
        typeof preferences.remove === 'function') {
        return preferences;
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
function tryRegisterPlugin() {
    const plugin = globalThis?.Capacitor?.Plugins?.LiveMode;
    if (!plugin || typeof plugin !== 'object') {
        return null;
    }
    const hasRequiredMethods = typeof plugin.startLiveMode === 'function' &&
        typeof plugin.stopLiveMode === 'function' &&
        typeof plugin.getLiveModeStatus === 'function' &&
        typeof plugin.addListener === 'function';
    if (!hasRequiredMethods) {
        return null;
    }
    return plugin;
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
    plugin;
    preferences;
    state = 'idle';
    listeners = [];
    nativeListenerHandle = null;
    constructor(plugin = tryRegisterPlugin(), preferences = resolvePreferences()) {
        this.plugin = plugin;
        this.preferences = preferences;
    }
    /**
     * Restore state from native plugin + preferences.
     * Call once on app startup before reading getState().
     */
    async initialize() {
        if (this.plugin) {
            try {
                const status = await this.plugin.getLiveModeStatus();
                this.state = status.state;
            }
            catch {
                // Plugin unavailable or service not running — default to idle.
                this.state = 'idle';
            }
            // Subscribe to native service lifecycle events.
            try {
                const listenerResult = this.plugin.addListener('liveModeStatusChanged', (event) => {
                    this.state = event.state;
                    this.emitChange(event);
                });
                if (listenerResult &&
                    typeof listenerResult.then === 'function') {
                    listenerResult
                        .then((handle) => {
                        this.nativeListenerHandle = handle;
                    })
                        .catch(() => {
                        /* listener setup failed — operate without events */
                    });
                }
                else if (listenerResult &&
                    typeof listenerResult.remove === 'function') {
                    this.nativeListenerHandle = listenerResult;
                }
            }
            catch {
                /* listener setup failed — operate without events */
            }
        }
        else {
            // Non-native environment: check persisted preference.
            const { value } = await this.preferences.get({ key: PREF_KEY_ENABLED });
            this.state = value === 'true' ? 'live' : 'idle';
        }
    }
    /**
     * Start Live Mode foreground service.
     * Idempotent: no-op if already live or starting.
     */
    async startLiveMode() {
        if (this.state === 'live' || this.state === 'starting')
            return;
        this.applyState('starting');
        if (this.plugin) {
            try {
                const result = await this.plugin.startLiveMode();
                this.applyState(result.state);
                await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'true' });
            }
            catch (e) {
                this.applyState('idle', 'start_failed');
                throw e;
            }
        }
        else {
            // Web/test fallback: simulate transition.
            this.applyState('live');
            await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'true' });
        }
    }
    /**
     * Stop Live Mode foreground service and return to Idle Mode.
     * Idempotent: no-op if already idle or stopping.
     */
    async stopLiveMode() {
        if (this.state === 'idle' || this.state === 'stopping')
            return;
        this.applyState('stopping');
        if (this.plugin) {
            try {
                const result = await this.plugin.stopLiveMode();
                this.applyState(result.state);
            }
            catch {
                this.applyState('idle', 'stop_error');
            }
        }
        else {
            this.applyState('idle');
        }
        await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'false' });
    }
    /**
     * Toggle between Live and Idle modes.
     */
    async toggle() {
        if (this.state === 'live' || this.state === 'starting') {
            await this.stopLiveMode();
        }
        else {
            await this.startLiveMode();
        }
    }
    /**
     * Force-stop Live Mode when auth failure occurs.
     * Does not throw; best-effort cleanup.
     */
    async handleAuthFailure() {
        try {
            await this.stopLiveMode();
        }
        catch {
            this.applyState('idle', 'auth_failure');
            await this.preferences.set({ key: PREF_KEY_ENABLED, value: 'false' }).catch(() => { });
        }
    }
    getState() {
        return this.state;
    }
    isLive() {
        return this.state === 'live';
    }
    /**
     * Subscribe to state change events. Returns an unsubscribe function.
     */
    addListener(cb) {
        this.listeners.push(cb);
        return () => {
            const idx = this.listeners.indexOf(cb);
            if (idx !== -1)
                this.listeners.splice(idx, 1);
        };
    }
    /** Release native listener handle on teardown. */
    destroy() {
        if (this.nativeListenerHandle) {
            this.nativeListenerHandle.remove();
            this.nativeListenerHandle = null;
        }
        this.listeners.length = 0;
    }
    applyState(state, reason) {
        this.state = state;
        this.emitChange({ state, reason });
    }
    emitChange(event) {
        for (const cb of this.listeners) {
            try {
                cb(event);
            }
            catch {
                /* listener errors must not crash controller */
            }
        }
    }
}
