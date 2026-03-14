type SecureStorageLike = {
  get: (opts: { key: string }) => Promise<{ value: string }>;
  set: (opts: { key: string; value: string }) => Promise<void>;
  remove: (opts: { key: string }) => Promise<void>;
};

function createFallbackSecureStorage(): SecureStorageLike {
  const inMemory = new Map<string, string>();

  return {
    async get({ key }) {
      const value = inMemory.get(key);
      if (value === undefined) {
        throw new Error('Item with given key does not exist');
      }
      return { value };
    },
    async set({ key, value }) {
      inMemory.set(key, value);
    },
    async remove({ key }) {
      inMemory.delete(key);
    }
  };
}

function resolveSecureStorage(): SecureStorageLike {
  const plugins = (globalThis as any)?.Capacitor?.Plugins;

  // Most plugin setups expose this exact key.
  if (plugins?.SecureStoragePlugin) {
    return plugins.SecureStoragePlugin as SecureStorageLike;
  }

  // Some environments may alias this.
  if (plugins?.SecureStorage) {
    return plugins.SecureStorage as SecureStorageLike;
  }

  // Test/browser fallback only.
  return createFallbackSecureStorage();
}

const SecureStorage = resolveSecureStorage();

export class SecureTokenStore {
  private getKey(profileId: string): string {
    return `rho_token_${profileId}`;
  }

  async getToken(profileId: string): Promise<string | null> {
    try {
      const result = await SecureStorage.get({ key: this.getKey(profileId) });
      return result.value;
    } catch (e: any) {
      if (e?.message?.includes('Item with given key does not exist')) {
        return null;
      }
      console.error('Failed to get secure token', e);
      return null;
    }
  }

  async setToken(profileId: string, token: string): Promise<void> {
    if (!token) {
      throw new Error('Token cannot be empty');
    }

    try {
      await SecureStorage.set({
        key: this.getKey(profileId),
        value: token
      });
    } catch (e: any) {
      console.error('Failed to set secure token', e);
      throw new Error(`Failed to securely store token: ${e?.message}`);
    }
  }

  async deleteToken(profileId: string): Promise<void> {
    try {
      await SecureStorage.remove({ key: this.getKey(profileId) });
    } catch (e: any) {
      console.error('Failed to delete secure token', e);
    }
  }
}
