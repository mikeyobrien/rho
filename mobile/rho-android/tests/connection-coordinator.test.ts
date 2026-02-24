import { ConnectionCoordinator } from '../src/connection-coordinator';
import { ProfileRepository } from '../src/storage/profile-repository';
import { SecureTokenStore } from '../src/storage/secure-token-store';
import { Profile } from '../src/models/profile';

// Mock the storages
jest.mock('../src/storage/profile-repository');
jest.mock('../src/storage/secure-token-store');

describe('ConnectionCoordinator', () => {
  let coordinator: ConnectionCoordinator;
  let mockProfileRepo: jest.Mocked<ProfileRepository>;
  let mockTokenStore: jest.Mocked<SecureTokenStore>;

  const validProfile: Profile = {
    id: 'test-1',
    name: 'Test Profile',
    scheme: 'http',
    host: 'localhost',
    port: 8080
  };

  beforeEach(() => {
    mockProfileRepo = new ProfileRepository() as jest.Mocked<ProfileRepository>;
    mockTokenStore = new SecureTokenStore() as jest.Mocked<SecureTokenStore>;
    coordinator = new ConnectionCoordinator(mockProfileRepo, mockTokenStore);

    mockProfileRepo.getProfiles.mockResolvedValue([validProfile]);
    mockTokenStore.getToken.mockResolvedValue('valid-token');

    // Reset fetch mock
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return success and URL when connection and exchange succeed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({})
    });

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe('http://localhost:8080/?mobile_shell=1');
    }

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/auth/exchange',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: 'Bearer valid-token' }
      })
    );
    expect(mockProfileRepo.setLastUsedProfileId).toHaveBeenCalledWith('test-1');
  });

  it('should append mobile bootstrap token to launch URL when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bootstrapToken: 'abc123' })
    });

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = new URL(result.url);
      expect(parsed.searchParams.get('mobile_shell')).toBe('1');
      expect(parsed.searchParams.get('auth_bootstrap')).toBe('abc123');
    }
  });

  it('should launch directly when token is missing', async () => {
    mockTokenStore.getToken.mockResolvedValue(null);

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe('http://localhost:8080/?mobile_shell=1');
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockProfileRepo.setLastUsedProfileId).toHaveBeenCalledWith('test-1');
  });

  it('should fall back to direct launch when server says auth is disabled', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Auth is disabled' })
    });

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe('http://localhost:8080/?mobile_shell=1');
    }
  });

  it('should disconnect and clear last used profile id', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    });

    await coordinator.disconnect('test-1');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
    expect(mockProfileRepo.setLastUsedProfileId).toHaveBeenCalledWith(null);
  });

  it('should handle switch flow between two profiles cleanly', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({})
    });

    // Use a non-default HTTPS port (8443) — URL normalises away default port 443
    const profile2: Profile = {
      id: 'test-2',
      name: 'Test Profile 2',
      scheme: 'https',
      host: 'example.com',
      port: 8443
    };
    mockProfileRepo.getProfiles.mockResolvedValue([validProfile, profile2]);
    mockTokenStore.getToken.mockResolvedValue('valid-token');

    // Connect to profile 1
    const res1 = await coordinator.connect('test-1');
    expect(res1.success).toBe(true);
    expect(mockProfileRepo.setLastUsedProfileId).toHaveBeenCalledWith('test-1');

    // Disconnect profile 1 (Switch initiated)
    await coordinator.disconnect('test-1');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
    expect(mockProfileRepo.setLastUsedProfileId).toHaveBeenCalledWith(null);

    // Connect to profile 2
    const res2 = await coordinator.connect('test-2');
    expect(res2.success).toBe(true);
    if (res2.success) {
      expect(res2.url).toBe('https://example.com:8443/?mobile_shell=1');
    }
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com:8443/api/auth/exchange',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
    expect(mockProfileRepo.setLastUsedProfileId).toHaveBeenCalledWith('test-2');
  });

  it('should handle network unreachable failure', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('NETWORK_ERROR');
    }
  });

  it('should handle invalid token (401)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid token' })
    });

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('INVALID_TOKEN');
    }
  });

  it('should handle generic 403 as invalid token', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden' })
    });

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('INVALID_TOKEN');
    }
  });

  it('should handle malformed host/profile URL', async () => {
    const malformedProfile: Profile = {
      id: 'test-bad-url',
      name: 'Bad URL',
      scheme: 'http',
      host: 'localhost',
      port: -1
    };

    mockProfileRepo.getProfiles.mockResolvedValue([malformedProfile]);
    mockTokenStore.getToken.mockResolvedValue('valid-token');

    const result = await coordinator.connect('test-bad-url');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('MALFORMED_URL');
    }
  });

  it('should handle missing profile', async () => {
    const result = await coordinator.connect('non-existent');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('UNKNOWN_ERROR');
      expect(result.error).toBe('Profile not found');
    }
  });

  it('should handle unknown server errors (500)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' })
    });

    const result = await coordinator.connect('test-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.type).toBe('UNKNOWN_ERROR');
      expect(result.error).toContain('Server error: 500');
    }
  });
});
