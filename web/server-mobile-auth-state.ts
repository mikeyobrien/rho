export const SESSION_COOKIE_NAME = "rho_mobile_session";

export interface SessionInfo {
	expiresAt: number;
}

export interface BootstrapSessionInfo {
	sessionId: string;
	expiresAt: number;
}

// In-memory store of active sessions
export const activeSessions = new Map<string, SessionInfo>();

// One-time bootstrap tokens used to set first-party cookie on initial navigation.
export const pendingBootstrapTokens = new Map<string, BootstrapSessionInfo>();
