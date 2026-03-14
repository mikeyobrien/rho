import { AppLifecycle, AppView } from '../src/app-lifecycle';
import { ConnectionCoordinator } from '../src/connection-coordinator';
import { ProfileRepository } from '../src/storage/profile-repository';
import { Profile } from '../src/models/profile';

jest.mock('../src/connection-coordinator');
jest.mock('../src/storage/profile-repository');
jest.mock('../src/mapConnectionErrorToMessage', () => ({
  mapConnectionErrorToMessage: jest.fn(() => 'Connection failed: mocked message')
}));

const profile1: Profile = { id: 'p1', name: 'Local', scheme: 'http', host: 'localhost', port: 8080 };
const profile2: Profile = { id: 'p2', name: 'Remote', scheme: 'https', host: '192.168.1.50', port: 8443 };

function makeView(): jest.Mocked<AppView> {
  return {
    showWebContainer: jest.fn(),
    hideWebContainer: jest.fn(),
    showError: jest.fn(),
    refreshProfiles: jest.fn().mockResolvedValue(undefined)
  };
}

describe('AppLifecycle', () => {
  let mockCoordinator: jest.Mocked<ConnectionCoordinator>;
  let mockProfileRepo: jest.Mocked<ProfileRepository>;
  let view: jest.Mocked<AppView>;
  let lifecycle: AppLifecycle;

  beforeEach(() => {
    mockCoordinator = new ConnectionCoordinator(null as any, null as any) as jest.Mocked<ConnectionCoordinator>;
    mockProfileRepo = new ProfileRepository() as jest.Mocked<ProfileRepository>;
    view = makeView();
    lifecycle = new AppLifecycle(mockProfileRepo, mockCoordinator, view);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Startup / last-used auto-open
  // -------------------------------------------------------------------------

  describe('onStartup — last-used auto-open', () => {
    it('auto-connects to last used profile when it still exists', async () => {
      mockProfileRepo.getLastUsedProfileId.mockResolvedValue('p1');
      mockProfileRepo.getProfiles.mockResolvedValue([profile1]);
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'http://localhost:8080/' });

      await lifecycle.onStartup();

      expect(mockCoordinator.connect).toHaveBeenCalledWith('p1');
      expect(view.showWebContainer).toHaveBeenCalledWith('http://localhost:8080/');
      expect(view.showError).not.toHaveBeenCalled();
    });

    it('does nothing when no last used profile id is stored', async () => {
      mockProfileRepo.getLastUsedProfileId.mockResolvedValue(null);

      await lifecycle.onStartup();

      expect(mockCoordinator.connect).not.toHaveBeenCalled();
      expect(view.showWebContainer).not.toHaveBeenCalled();
    });

    it('skips auto-connect when last used profile was deleted', async () => {
      mockProfileRepo.getLastUsedProfileId.mockResolvedValue('p-deleted');
      mockProfileRepo.getProfiles.mockResolvedValue([profile1, profile2]);

      await lifecycle.onStartup();

      expect(mockCoordinator.connect).not.toHaveBeenCalled();
      expect(view.showWebContainer).not.toHaveBeenCalled();
    });

    it('shows error when auto-connect fails (e.g. network down)', async () => {
      mockProfileRepo.getLastUsedProfileId.mockResolvedValue('p1');
      mockProfileRepo.getProfiles.mockResolvedValue([profile1]);
      mockCoordinator.connect.mockResolvedValue({
        success: false,
        error: 'Network unreachable',
        type: 'NETWORK_ERROR'
      });

      await lifecycle.onStartup();

      expect(view.showError).toHaveBeenCalledWith('Connection failed: mocked message');
      expect(view.showWebContainer).not.toHaveBeenCalled();
    });

    it('tracks active profile id after successful auto-connect', async () => {
      mockProfileRepo.getLastUsedProfileId.mockResolvedValue('p2');
      mockProfileRepo.getProfiles.mockResolvedValue([profile1, profile2]);
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'https://192.168.1.50:8443/' });

      await lifecycle.onStartup();

      expect(lifecycle.getActiveProfileId()).toBe('p2');
    });

    it('leaves active profile null when auto-connect fails', async () => {
      mockProfileRepo.getLastUsedProfileId.mockResolvedValue('p1');
      mockProfileRepo.getProfiles.mockResolvedValue([profile1]);
      mockCoordinator.connect.mockResolvedValue({
        success: false,
        error: 'Invalid token',
        type: 'INVALID_TOKEN'
      });

      await lifecycle.onStartup();

      expect(lifecycle.getActiveProfileId()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  describe('connect', () => {
    it('opens container on success and sets active profile', async () => {
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'http://localhost:8080/' });

      await lifecycle.connect('p1');

      expect(view.showWebContainer).toHaveBeenCalledWith('http://localhost:8080/');
      expect(lifecycle.getActiveProfileId()).toBe('p1');
    });

    it('shows error on failure and leaves active profile null', async () => {
      mockCoordinator.connect.mockResolvedValue({
        success: false,
        error: 'Missing token',
        type: 'MISSING_TOKEN'
      });

      await lifecycle.connect('p1');

      expect(view.showError).toHaveBeenCalledWith('Connection failed: mocked message');
      expect(view.showWebContainer).not.toHaveBeenCalled();
      expect(lifecycle.getActiveProfileId()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // switchProfile — teardown + return to picker
  // -------------------------------------------------------------------------

  describe('switchProfile', () => {
    it('disconnects active profile, clears container, and refreshes picker', async () => {
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'http://localhost:8080/' });
      await lifecycle.connect('p1');
      expect(lifecycle.getActiveProfileId()).toBe('p1');

      mockCoordinator.disconnect.mockResolvedValue(undefined);
      await lifecycle.switchProfile();

      expect(mockCoordinator.disconnect).toHaveBeenCalledWith('p1');
      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(view.refreshProfiles).toHaveBeenCalled();
      expect(lifecycle.getActiveProfileId()).toBeNull();
    });

    it('still tears down UI and clears active profile when disconnect throws', async () => {
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'http://localhost:8080/' });
      await lifecycle.connect('p1');
      expect(lifecycle.getActiveProfileId()).toBe('p1');

      mockCoordinator.disconnect.mockRejectedValue(new Error('logout failed'));
      await lifecycle.switchProfile();

      expect(mockCoordinator.disconnect).toHaveBeenCalledWith('p1');
      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(view.refreshProfiles).toHaveBeenCalled();
      expect(lifecycle.getActiveProfileId()).toBeNull();
    });

    it('still clears container and refreshes picker when no active profile', async () => {
      await lifecycle.switchProfile();

      expect(mockCoordinator.disconnect).not.toHaveBeenCalled();
      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(view.refreshProfiles).toHaveBeenCalled();
    });

    it('switch flow between two profiles — full round trip', async () => {
      // Step 1: connect to profile 1
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'http://localhost:8080/' });
      await lifecycle.connect('p1');
      expect(lifecycle.getActiveProfileId()).toBe('p1');
      expect(view.showWebContainer).toHaveBeenLastCalledWith('http://localhost:8080/');

      // Step 2: switch — tears down profile 1
      mockCoordinator.disconnect.mockResolvedValue(undefined);
      await lifecycle.switchProfile();
      expect(mockCoordinator.disconnect).toHaveBeenCalledWith('p1');
      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(lifecycle.getActiveProfileId()).toBeNull();

      // Step 3: connect to profile 2
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'https://192.168.1.50:8443/' });
      await lifecycle.connect('p2');
      expect(lifecycle.getActiveProfileId()).toBe('p2');
      expect(view.showWebContainer).toHaveBeenLastCalledWith('https://192.168.1.50:8443/');
    });

    it('clears active profile even when disconnect is called without a prior connect', async () => {
      // Simulate lifecycle where active state was lost but we still switch
      mockCoordinator.disconnect.mockResolvedValue(undefined);
      await lifecycle.switchProfile();

      expect(lifecycle.getActiveProfileId()).toBeNull();
      expect(view.hideWebContainer).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // handleAuthFailure — recover from auth failure
  // -------------------------------------------------------------------------

  describe('handleAuthFailure', () => {
    beforeEach(() => {
      mockCoordinator.connect.mockResolvedValue({ success: true, url: 'http://localhost:8080/' });
    });

    it('tears down container and shows expired message', async () => {
      await lifecycle.connect('p1');
      await lifecycle.handleAuthFailure('expired');

      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(view.showError).toHaveBeenCalledWith('Your session expired. Please log in again.');
      expect(lifecycle.getActiveProfileId()).toBeNull();
    });

    it('tears down container and shows revoked message', async () => {
      await lifecycle.connect('p1');
      await lifecycle.handleAuthFailure('revoked');

      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(view.showError).toHaveBeenCalledWith('Your token was revoked or is invalid. Please update your profile.');
      expect(lifecycle.getActiveProfileId()).toBeNull();
    });

    it('tears down container and shows missing_cookie message', async () => {
      await lifecycle.connect('p1');
      await lifecycle.handleAuthFailure('missing_cookie');

      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(view.showError).toHaveBeenCalledWith('Session cookie lost. Please log in again.');
      expect(lifecycle.getActiveProfileId()).toBeNull();
    });

    it('tears down container and shows default message for unknown reason', async () => {
      await lifecycle.connect('p1');
      await lifecycle.handleAuthFailure('unknown');

      expect(view.hideWebContainer).toHaveBeenCalled();
      expect(view.showError).toHaveBeenCalledWith('Your session has ended. Please log in again.');
      expect(lifecycle.getActiveProfileId()).toBeNull();
    });
  });
});
