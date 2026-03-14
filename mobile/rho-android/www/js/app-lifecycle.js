import { mapConnectionErrorToMessage } from './mapConnectionErrorToMessage.js';
/**
 * Step 6 — startup resume, last-used profile auto-connect, and in-app
 * profile switching.  Extracted from index.ts so it can be unit tested
 * without a DOM.
 */
export class AppLifecycle {
    profileRepo;
    coordinator;
    view;
    liveMode;
    activeProfileId = null;
    constructor(profileRepo, coordinator, view, liveMode) {
        this.profileRepo = profileRepo;
        this.coordinator = coordinator;
        this.view = view;
        this.liveMode = liveMode;
    }
    /**
     * Call once on app startup.  Auto-connects to last used profile when one
     * exists in the profile list; silently skips when there is no record or
     * the profile has been deleted.
     */
    async onStartup() {
        const lastUsedProfileId = await this.profileRepo.getLastUsedProfileId();
        if (!lastUsedProfileId)
            return;
        const profiles = await this.profileRepo.getProfiles();
        const exists = profiles.some(p => p.id === lastUsedProfileId);
        if (!exists)
            return;
        await this.connect(lastUsedProfileId);
    }
    /**
     * Authenticate and open the web container for the given profile.
     * On failure the view receives an error message; container is not shown.
     */
    async connect(profileId) {
        const result = await this.coordinator.connect(profileId);
        if (result.success) {
            this.activeProfileId = profileId;
            this.view.showWebContainer(result.url);
        }
        else {
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
    async switchProfile() {
        const profileId = this.activeProfileId;
        this.activeProfileId = null;
        // Stop Live Mode before tearing down the session so the foreground
        // service is not left running without an active session.
        if (this.liveMode) {
            try {
                await this.liveMode.stopLiveMode();
            }
            catch {
                /* best effort */
            }
        }
        if (profileId) {
            try {
                await this.coordinator.disconnect(profileId);
            }
            catch {
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
    async handleAuthFailure(reason) {
        // Stop Live Mode before returning to picker (fail-closed on auth).
        if (this.liveMode) {
            try {
                await this.liveMode.handleAuthFailure();
            }
            catch {
                /* best effort */
            }
        }
        await this.switchProfile();
        let message = 'Your session has ended. Please log in again.';
        if (reason === 'revoked') {
            message = 'Your token was revoked or is invalid. Please update your profile.';
        }
        else if (reason === 'expired') {
            message = 'Your session expired. Please log in again.';
        }
        else if (reason === 'missing_cookie') {
            message = 'Session cookie lost. Please log in again.';
        }
        this.view.showError(message);
    }
    getActiveProfileId() {
        return this.activeProfileId;
    }
}
