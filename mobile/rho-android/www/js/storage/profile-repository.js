import { validateProfile } from '../models/profile.js';
const PROFILES_KEY = 'rho_profiles';
const LAST_USED_PROFILE_KEY = 'rho_last_used_profile';
function createFallbackPreferences() {
    const inMemory = new Map();
    const hasLocalStorage = typeof globalThis !== 'undefined' &&
        typeof globalThis.localStorage !== 'undefined';
    return {
        async get({ key }) {
            if (hasLocalStorage) {
                try {
                    const value = globalThis.localStorage.getItem(key);
                    return { value };
                }
                catch {
                    // Fall through to in-memory.
                }
            }
            return { value: inMemory.get(key) ?? null };
        },
        async set({ key, value }) {
            if (hasLocalStorage) {
                try {
                    globalThis.localStorage.setItem(key, value);
                    return;
                }
                catch {
                    // Fall through to in-memory.
                }
            }
            inMemory.set(key, value);
        },
        async remove({ key }) {
            if (hasLocalStorage) {
                try {
                    globalThis.localStorage.removeItem(key);
                    return;
                }
                catch {
                    // Fall through to in-memory.
                }
            }
            inMemory.delete(key);
        }
    };
}
function resolvePreferences() {
    const plugins = globalThis?.Capacitor?.Plugins;
    if (plugins?.Preferences) {
        return plugins.Preferences;
    }
    return createFallbackPreferences();
}
const Preferences = resolvePreferences();
export class ProfileRepository {
    async getLastUsedProfileId() {
        const { value } = await Preferences.get({ key: LAST_USED_PROFILE_KEY });
        return value;
    }
    async setLastUsedProfileId(id) {
        if (id === null) {
            await Preferences.remove({ key: LAST_USED_PROFILE_KEY });
        }
        else {
            await Preferences.set({ key: LAST_USED_PROFILE_KEY, value: id });
        }
    }
    async getProfiles() {
        const { value } = await Preferences.get({ key: PROFILES_KEY });
        if (!value) {
            return [];
        }
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed.filter((p) => validateProfile(p).valid);
            }
        }
        catch (e) {
            console.error('Failed to parse profiles', e);
        }
        return [];
    }
    async saveProfile(profile) {
        const validation = validateProfile(profile);
        if (!validation.valid) {
            throw new Error(`Invalid profile: ${validation.errors.join(', ')}`);
        }
        const profiles = await this.getProfiles();
        const existingIndex = profiles.findIndex((p) => p.id === profile.id);
        // Strip any extra fields (like tokens) to enforce split-trust securely.
        const safeProfile = {
            id: profile.id,
            name: profile.name,
            scheme: profile.scheme,
            host: profile.host,
            port: profile.port
        };
        if (existingIndex >= 0) {
            profiles[existingIndex] = safeProfile;
        }
        else {
            profiles.push(safeProfile);
        }
        await Preferences.set({
            key: PROFILES_KEY,
            value: JSON.stringify(profiles)
        });
    }
    async deleteProfile(id) {
        const profiles = await this.getProfiles();
        const filtered = profiles.filter((p) => p.id !== id);
        await Preferences.set({
            key: PROFILES_KEY,
            value: JSON.stringify(filtered)
        });
    }
}
