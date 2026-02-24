import { AppLifecycle } from './app-lifecycle.js';
import { ProfileRepository } from './storage/profile-repository.js';

export type AuthFailureReason = 'expired' | 'revoked' | 'missing_cookie' | 'network_error' | 'unknown';

export class SessionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  constructor(
    private readonly lifecycle: AppLifecycle,
    private readonly profileRepo: ProfileRepository,
    private readonly pollingIntervalMs = 5000
  ) {}

  private getShellHostname(): string | null {
    const location = (globalThis as any)?.location;
    if (!location || typeof location.hostname !== 'string') {
      return null;
    }

    const host = location.hostname.trim().toLowerCase();
    return host || null;
  }

  start() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.timer = setInterval(() => this.poll(), this.pollingIntervalMs);
  }

  stop() {
    this.isPolling = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    const profileId = this.lifecycle.getActiveProfileId();
    if (!profileId) {
      return;
    }

    const profiles = await this.profileRepo.getProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;

    let url: URL;
    try {
      url = new URL(`${profile.scheme}://${profile.host}:${profile.port}`);
    } catch {
      return;
    }

    const statusUrl = new URL('/api/auth/status', url);

    try {
      const response = await fetch(statusUrl.toString(), {
        method: 'GET',
        credentials: 'include'
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          await this.handleFailure('revoked');
        }
        return;
      }

      const data = await response.json();

      if (data.enabled && !data.active) {
        // In remote-host mode, shell origin (localhost) and profile host differ.
        // Cross-host cookie visibility from shell fetch can report false missing_cookie
        // even while the embedded rho-web session is active.
        if (data.reason === 'missing_cookie') {
          const shellHost = this.getShellHostname();
          if (shellHost && shellHost !== profile.host.toLowerCase()) {
            return;
          }
        }

        await this.handleFailure(data.reason as AuthFailureReason);
      }
    } catch (e) {
      // Network error, maybe transient. Don't tear down immediately on network error unless desired?
      // "Detect auth failure patterns from API responses and WS close/error events."
      // Let's not tear down on simple network errors, only explicit auth failures.
    }
  }

  async handleFailure(reason: AuthFailureReason) {
    this.stop();
    await this.lifecycle.handleAuthFailure(reason);
  }
}
