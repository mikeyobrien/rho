import { ProfileRepository } from './storage/profile-repository.js';
import { SecureTokenStore } from './storage/secure-token-store.js';

export type ConnectResult =
  | { success: true; url: string }
  | {
      success: false;
      error: string;
      type:
        | 'NETWORK_ERROR'
        | 'INVALID_TOKEN'
        | 'MALFORMED_URL'
        | 'UNKNOWN_ERROR'
        | 'MISSING_TOKEN';
    };

export class ConnectionCoordinator {
  constructor(
    private profileRepo: ProfileRepository,
    private tokenStore: SecureTokenStore
  ) {}

  private buildLaunchUrl(url: URL, bootstrapToken?: string): string {
    const launchUrl = new URL(url.toString());
    launchUrl.searchParams.set('mobile_shell', '1');

    if (bootstrapToken) {
      launchUrl.searchParams.set('auth_bootstrap', bootstrapToken);
    }

    return launchUrl.toString();
  }

  private async finalizeLaunch(
    profileId: string,
    url: URL,
    bootstrapToken?: string
  ): Promise<ConnectResult> {
    const launchUrl = this.buildLaunchUrl(url, bootstrapToken);
    await this.profileRepo.setLastUsedProfileId(profileId);
    return { success: true, url: launchUrl };
  }

  async connect(profileId: string): Promise<ConnectResult> {
    const profiles = await this.profileRepo.getProfiles();
    const profile = profiles.find(p => p.id === profileId);

    if (!profile) {
      return { success: false, error: 'Profile not found', type: 'UNKNOWN_ERROR' };
    }

    let url: URL;
    try {
      url = new URL(`${profile.scheme}://${profile.host}:${profile.port}`);
    } catch {
      return { success: false, error: 'Malformed host/profile URL', type: 'MALFORMED_URL' };
    }

    const token = await this.tokenStore.getToken(profileId);

    // Token is optional. If absent, launch directly and rely on whatever auth the host provides
    // (none/LAN, Tailscale/SSO, etc.).
    if (!token) {
      try {
        return await this.finalizeLaunch(profileId, url);
      } catch (e: any) {
        return {
          success: false,
          error: `Failed to open profile: ${e?.message ?? 'unknown error'}`,
          type: 'UNKNOWN_ERROR'
        };
      }
    }

    const authUrl = new URL('/api/auth/exchange', url);

    try {
      const response = await fetch(authUrl.toString(), {
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!response.ok) {
        let errorMessage = '';
        try {
          const body = (await response.json()) as { error?: string };
          if (typeof body?.error === 'string') {
            errorMessage = body.error;
          }
        } catch {
          // Ignore non-JSON / empty body.
        }

        // If server says token exchange is disabled, continue without exchange.
        if (response.status === 403 && errorMessage === 'Auth is disabled') {
          return await this.finalizeLaunch(profileId, url);
        }

        if (response.status === 401 || response.status === 403) {
          return { success: false, error: 'Invalid token', type: 'INVALID_TOKEN' };
        }
        return {
          success: false,
          error: `Server error: ${response.status}`,
          type: 'UNKNOWN_ERROR'
        };
      }

      // Success, token exchanged for cookie session.
      // Some WebView environments block third-party Set-Cookie during exchange,
      // so the server may return a one-time bootstrap token for first-party cookie set.
      let bootstrapToken: string | undefined;
      try {
        const body = (await response.json()) as { bootstrapToken?: string };
        if (typeof body?.bootstrapToken === 'string' && body.bootstrapToken.length > 0) {
          bootstrapToken = body.bootstrapToken;
        }
      } catch {
        // Ignore body parsing issues and continue with base URL.
      }

      return await this.finalizeLaunch(profileId, url, bootstrapToken);
    } catch {
      // Fetch throws TypeError on network failure.
      return { success: false, error: 'Network unreachable', type: 'NETWORK_ERROR' };
    }
  }

  async disconnect(profileId: string): Promise<void> {
    const profiles = await this.profileRepo.getProfiles();
    const profile = profiles.find(p => p.id === profileId);

    if (profile) {
      try {
        const url = new URL(`${profile.scheme}://${profile.host}:${profile.port}`);
        const authUrl = new URL('/api/auth/logout', url);
        await fetch(authUrl.toString(), {
          method: 'POST',
          credentials: 'include'
        });
      } catch {
        // Best effort logout, ignore errors
      }
    }

    await this.profileRepo.setLastUsedProfileId(null);
  }
}
