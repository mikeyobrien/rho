type Profile = {
  id: string;
  name: string;
  scheme: 'http' | 'https';
  host: string;
  port: number;
};

describe('Storage', () => {
  let prefStore: Record<string, string>;
  let secureStore: Record<string, string>;

  function installCapacitorMocks() {
    prefStore = {};
    secureStore = {};

    (globalThis as any).Capacitor = {
      Plugins: {
        Preferences: {
          get: async ({ key }: { key: string }) => ({ value: prefStore[key] ?? null }),
          set: async ({ key, value }: { key: string; value: string }) => {
            prefStore[key] = value;
          },
          remove: async ({ key }: { key: string }) => {
            delete prefStore[key];
          }
        },
        SecureStoragePlugin: {
          get: async ({ key }: { key: string }) => {
            if (!(key in secureStore)) {
              throw new Error('Item with given key does not exist');
            }
            return { value: secureStore[key] };
          },
          set: async ({ key, value }: { key: string; value: string }) => {
            secureStore[key] = value;
          },
          remove: async ({ key }: { key: string }) => {
            delete secureStore[key];
          }
        }
      }
    };
  }

  async function loadModules() {
    jest.resetModules();
    const repoMod = await import('../src/storage/profile-repository');
    const tokenMod = await import('../src/storage/secure-token-store');
    return {
      ProfileRepository: repoMod.ProfileRepository,
      SecureTokenStore: tokenMod.SecureTokenStore
    };
  }

  beforeEach(() => {
    installCapacitorMocks();
  });

  afterEach(() => {
    delete (globalThis as any).Capacitor;
  });

  describe('ProfileRepository', () => {
    it('should save and get profiles', async () => {
      const { ProfileRepository } = await loadModules();
      const repo = new ProfileRepository();
      const profile: Profile = {
        id: 'test-id',
        name: 'Test Profile',
        scheme: 'https',
        host: 'example.com',
        port: 443
      };

      await repo.saveProfile(profile as any);
      const profiles = await repo.getProfiles();

      expect(profiles.length).toBe(1);
      expect(profiles[0]).toEqual(profile);
    });

    it('should delete a profile', async () => {
      const { ProfileRepository } = await loadModules();
      const repo = new ProfileRepository();
      const profile: Profile = {
        id: 'test-id',
        name: 'Test Profile',
        scheme: 'https',
        host: 'example.com',
        port: 443
      };

      await repo.saveProfile(profile as any);
      await repo.deleteProfile('test-id');
      const profiles = await repo.getProfiles();

      expect(profiles.length).toBe(0);
    });

    it('should prove token is NOT written to metadata store', async () => {
      const { ProfileRepository } = await loadModules();
      const repo = new ProfileRepository();
      const profile = {
        id: 'test-id',
        name: 'Test Profile',
        scheme: 'https',
        host: 'example.com',
        port: 443,
        token: 'secret-token'
      } as any;

      await repo.saveProfile(profile);

      const serializedData = prefStore['rho_profiles'] || '';
      expect(serializedData).not.toContain('secret-token');
      expect(serializedData).toContain('Test Profile');
    });

    it('should save and get last used profile id', async () => {
      const { ProfileRepository } = await loadModules();
      const repo = new ProfileRepository();

      let id = await repo.getLastUsedProfileId();
      expect(id).toBeNull();

      await repo.setLastUsedProfileId('test-id-123');
      id = await repo.getLastUsedProfileId();
      expect(id).toBe('test-id-123');

      await repo.setLastUsedProfileId(null);
      id = await repo.getLastUsedProfileId();
      expect(id).toBeNull();
    });
  });

  describe('SecureTokenStore', () => {
    it('should save, get and delete token securely', async () => {
      const { SecureTokenStore } = await loadModules();
      const store = new SecureTokenStore();

      await store.setToken('test-id', 'my-secret-token');
      let token = await store.getToken('test-id');
      expect(token).toBe('my-secret-token');

      await store.deleteToken('test-id');
      token = await store.getToken('test-id');
      expect(token).toBeNull();
    });

    it('should throw an error on empty token', async () => {
      const { SecureTokenStore } = await loadModules();
      const store = new SecureTokenStore();
      await expect(store.setToken('test-id', '')).rejects.toThrow('Token cannot be empty');
    });
  });
});
