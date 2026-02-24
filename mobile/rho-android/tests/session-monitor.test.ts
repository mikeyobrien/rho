import { SessionMonitor } from '../src/session-monitor';
import { AppLifecycle } from '../src/app-lifecycle';
import { ProfileRepository } from '../src/storage/profile-repository';

jest.useFakeTimers();

describe('SessionMonitor', () => {
  let monitor: SessionMonitor;
  let mockLifecycle: jest.Mocked<AppLifecycle>;
  let mockProfileRepo: jest.Mocked<ProfileRepository>;
  const originalLocation = (globalThis as any).location;
  
  beforeEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: { hostname: 'localhost' },
      configurable: true
    });
    mockLifecycle = {
      getActiveProfileId: jest.fn().mockReturnValue('p1'),
      handleAuthFailure: jest.fn(),
    } as unknown as jest.Mocked<AppLifecycle>;

    mockProfileRepo = {
      getProfiles: jest.fn().mockResolvedValue([
        { id: 'p1', scheme: 'http', host: 'localhost', port: 8080 }
      ])
    } as unknown as jest.Mocked<ProfileRepository>;

    monitor = new SessionMonitor(mockLifecycle, mockProfileRepo, 1000);
    
    // Mock fetch
    global.fetch = jest.fn();
  });

  afterEach(() => {
    monitor.stop();
    jest.clearAllTimers();
    jest.clearAllMocks();

    if (originalLocation === undefined) {
      delete (globalThis as any).location;
    } else {
      Object.defineProperty(globalThis, 'location', {
        value: originalLocation,
        configurable: true
      });
    }
  });

  it('starts polling and fetches status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, active: true })
    });

    monitor.start();
    jest.advanceTimersByTime(1000);

    // Promise queue flush
    await Promise.resolve();
    await Promise.resolve();

    expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080/api/auth/status', expect.any(Object));
    expect(mockLifecycle.handleAuthFailure).not.toHaveBeenCalled();
  });

  it('triggers handleAuthFailure when status returns active=false and enabled=true', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, active: false, reason: 'expired' })
    });

    await monitor.poll();

    expect(mockLifecycle.handleAuthFailure).toHaveBeenCalledWith('expired');
  });

  it('ignores missing_cookie from cross-host shell polling (remote host mode)', async () => {
    mockProfileRepo.getProfiles.mockResolvedValue([
      { id: 'p1', scheme: 'http', host: 'tidepool', port: 3141 }
    ] as any);

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, active: false, reason: 'missing_cookie' })
    });

    await monitor.poll();

    expect(mockLifecycle.handleAuthFailure).not.toHaveBeenCalled();
  });

  it('triggers handleAuthFailure with revoked on 401', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401
    });

    await monitor.poll();

    expect(mockLifecycle.handleAuthFailure).toHaveBeenCalledWith('revoked');
  });

  it('stops polling if there is no active profile', async () => {
    mockLifecycle.getActiveProfileId.mockReturnValue(null);
    
    monitor.start();
    
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does nothing on simple network error (so transient failures do not drop session)', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
    
    await monitor.poll();

    expect(mockLifecycle.handleAuthFailure).not.toHaveBeenCalled();
  });

  it('delegates explicit failure handling (WS auth failure path)', async () => {
    await monitor.handleFailure('revoked');

    expect(mockLifecycle.handleAuthFailure).toHaveBeenCalledWith('revoked');
  });
});
