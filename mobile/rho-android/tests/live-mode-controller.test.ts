import { LiveModeController, LiveModePlugin, LiveModeState } from '../src/live-mode-controller';

type PreferencesHarness = {
  store: Map<string, string>;
  preferences: {
    get: jest.Mock<Promise<{ value: string | null }>, [{ key: string }]>;
    set: jest.Mock<Promise<void>, [{ key: string; value: string }]>;
    remove: jest.Mock<Promise<void>, [{ key: string }]>;
  };
};

type PluginHarness = {
  plugin: LiveModePlugin & {
    startLiveMode: jest.Mock;
    stopLiveMode: jest.Mock;
    getLiveModeStatus: jest.Mock;
    addListener: jest.Mock;
  };
  emit: (state: LiveModeState) => void;
};

function createPreferencesHarness(initial: Record<string, string> = {}): PreferencesHarness {
  const store = new Map<string, string>(Object.entries(initial));

  return {
    store,
    preferences: {
      get: jest.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
      set: jest.fn(async ({ key, value }: { key: string; value: string }) => {
        store.set(key, value);
      }),
      remove: jest.fn(async ({ key }: { key: string }) => {
        store.delete(key);
      }),
    },
  };
}

function createPluginHarness(
  initialState: LiveModeState = 'idle',
  mode: 'async' | 'sync' = 'async'
): PluginHarness {
  let listener: ((event: { state: LiveModeState }) => void) | null = null;

  const addListenerImpl = mode === 'sync'
    ? jest.fn((_event: 'liveModeStatusChanged', cb: (event: { state: LiveModeState }) => void) => {
        listener = cb;
        return { remove: jest.fn() };
      })
    : jest.fn(async (_event: 'liveModeStatusChanged', cb: (event: { state: LiveModeState }) => void) => {
        listener = cb;
        return { remove: jest.fn() };
      });

  const plugin: PluginHarness['plugin'] = {
    startLiveMode: jest.fn(async () => ({ state: 'live' as LiveModeState })),
    stopLiveMode: jest.fn(async () => ({ state: 'idle' as LiveModeState })),
    getLiveModeStatus: jest.fn(async () => ({ state: initialState as LiveModeState })),
    addListener: addListenerImpl,
  };

  return {
    plugin,
    emit(state: LiveModeState) {
      listener?.({ state });
    },
  };
}

describe('LiveModeController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initializes from native plugin status and receives plugin status events (async listener)', async () => {
    const prefs = createPreferencesHarness();
    const harness = createPluginHarness('idle', 'async');
    const controller = new LiveModeController(harness.plugin, prefs.preferences);

    await controller.initialize();

    expect(harness.plugin.getLiveModeStatus).toHaveBeenCalled();
    expect(controller.getState()).toBe('idle');

    harness.emit('live');
    expect(controller.getState()).toBe('live');
  });

  it('initializes with synchronous plugin listener handles', async () => {
    const prefs = createPreferencesHarness();
    const harness = createPluginHarness('idle', 'sync');
    const controller = new LiveModeController(harness.plugin, prefs.preferences);

    await controller.initialize();

    harness.emit('live');
    expect(controller.getState()).toBe('live');
  });

  it('startLiveMode transitions to live and persists preference', async () => {
    const prefs = createPreferencesHarness();
    const harness = createPluginHarness('idle');
    const controller = new LiveModeController(harness.plugin, prefs.preferences);
    await controller.initialize();

    await controller.startLiveMode();

    expect(harness.plugin.startLiveMode).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('live');
    expect(prefs.preferences.set).toHaveBeenCalledWith({ key: 'live_mode_enabled', value: 'true' });
  });

  it('stopLiveMode transitions to idle and persists preference false', async () => {
    const prefs = createPreferencesHarness();
    const harness = createPluginHarness('live');
    const controller = new LiveModeController(harness.plugin, prefs.preferences);
    await controller.initialize();

    await controller.stopLiveMode();

    expect(harness.plugin.stopLiveMode).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('idle');
    expect(prefs.preferences.set).toHaveBeenCalledWith({ key: 'live_mode_enabled', value: 'false' });
  });

  it('toggle starts and stops in sequence', async () => {
    const prefs = createPreferencesHarness();
    const harness = createPluginHarness('idle');
    const controller = new LiveModeController(harness.plugin, prefs.preferences);
    await controller.initialize();

    await controller.toggle();
    expect(controller.getState()).toBe('live');

    await controller.toggle();
    expect(controller.getState()).toBe('idle');
    expect(harness.plugin.startLiveMode).toHaveBeenCalledTimes(1);
    expect(harness.plugin.stopLiveMode).toHaveBeenCalledTimes(1);
  });

  it('handleAuthFailure is fail-closed when native stop throws', async () => {
    const prefs = createPreferencesHarness();
    const harness = createPluginHarness('live');
    harness.plugin.stopLiveMode.mockRejectedValueOnce(new Error('native stop failed'));

    const controller = new LiveModeController(harness.plugin, prefs.preferences);
    await controller.initialize();

    await controller.handleAuthFailure();

    expect(controller.getState()).toBe('idle');
    expect(prefs.preferences.set).toHaveBeenCalledWith({ key: 'live_mode_enabled', value: 'false' });
  });

  it('fallback mode (no plugin) restores and toggles from preferences', async () => {
    const prefs = createPreferencesHarness({ live_mode_enabled: 'true' });
    const controller = new LiveModeController(null, prefs.preferences);

    await controller.initialize();
    expect(controller.getState()).toBe('live');

    await controller.stopLiveMode();
    expect(controller.getState()).toBe('idle');

    await controller.startLiveMode();
    expect(controller.getState()).toBe('live');
  });
});
