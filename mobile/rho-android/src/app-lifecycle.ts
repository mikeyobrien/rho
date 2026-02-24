import { ConnectionCoordinator } from './connection-coordinator.js';
import { ProfileRepository } from './storage/profile-repository.js';
import { mapConnectionErrorToMessage } from './mapConnectionErrorToMessage.js';

/**
 * View contract that AppLifecycle drives.
 * The concrete implementation lives in index.ts; tests inject a mock.
 */
export interface AppView {
  showWebContainer(url: string): void;
  hideWebContainer(): void;
  showError(message: string): void;
  refreshProfiles(): Promise<void>;
}

/**
 * Minimal Live Mode interface dependency — keeps AppLifecycle decoupled from
 * the full LiveModeController while still stopping the foreground service on
 * auth failure / profile switch.
 */
export interface LiveModeHandle {
  handleAuthFailure(): Promise<void>;
  stopLiveMode(): Promise<void>;
}

/**
 * Step 6 — startup resume, last-used profile auto-connect, and in-app
 * profile switching.  Extracted from index.ts so it can be unit tested
 * without a DOM.
 */
export class AppLifecycle {
  private activeProfileId: string | null = null;

  constructor(
    private readonly profileRepo: ProfileRepository,
    private readonly coordinator: ConnectionCoordinator,
    private readonly view: AppView,
    private readonly liveMode?: LiveModeHandle
  ) {}

  /**
   * Call once on app startup.  Auto-connects to last used profile when one
   * exists in the profile list; silently skips when there is no record or
   * the profile has been deleted.
   */
  async onStartup(): Promise<void> {
    const lastUsedProfileId = await this.profileRepo.getLastUsedProfileId();
    if (!lastUsedProfileId) return;

    const profiles = await this.profileRepo.getProfiles();
    const exists = profiles.some(p => p.id === lastUsedProfileId);
    if (!exists) return;

    await this.connect(lastUsedProfileId);
  }

  /**
   * Authenticate and open the web container for the given profile.
   * On failure the view receives an error message; container is not shown.
   */
  async connect(profileId: string): Promise<void> {
    const result = await this.coordinator.connect(profileId);
    if (result.success) {
      this.activeProfileId = profileId;
      this.view.showWebContainer(result.url);
    } else {
      const message = mapConnectionErrorToMessage(result);
      this.view.showError(message);
    }
  }

  /**
   * Tear down the current session and return to the profile picker.
   * Best-effort: calls coordinator.disconnect (which attempts mobile logout),
   * but always clears the container even if logout fails.
   * Also stops Live Mode foreground service if running.
   */
  async switchProfile(): Promise<void> {
    const profileId = this.activeProfileId;
    this.activeProfileId = null;

    // Stop Live Mode before tearing down the session so the foreground
    // service is not left running without an active session.
    if (this.liveMode) {
      try {
        await this.liveMode.stopLiveMode();
      } catch {
        /* best effort */
      }
    }

    if (profileId) {
      try {
        await this.coordinator.disconnect(profileId);
      } catch {
        // Best effort: always continue teardown to return to picker
      }
    }

    this.view.hideWebContainer();
    await this.view.refreshProfiles();
  }

  /**
   * Handle session expiration or token revocation by returning to the profile picker
   * and displaying an appropriate error message to the user.
   * Stops Live Mode service so no orphaned foreground service remains.
   */
  async handleAuthFailure(reason: 'expired' | 'revoked' | 'missing_cookie' | 'network_error' | 'unknown' | string): Promise<void> {
    // Stop Live Mode before returning to picker (fail-closed on auth).
    if (this.liveMode) {
      try {
        await this.liveMode.handleAuthFailure();
      } catch {
        /* best effort */
      }
    }

    await this.switchProfile();
    
    let message = 'Your session has ended. Please log in again.';
    if (reason === 'revoked') {
      message = 'Your token was revoked or is invalid. Please update your profile.';
    } else if (reason === 'expired') {
      message = 'Your session expired. Please log in again.';
    } else if (reason === 'missing_cookie') {
      message = 'Session cookie lost. Please log in again.';
    }

    this.view.showError(message);
  }

  getActiveProfileId(): string | null {
    return this.activeProfileId;
  }
}
