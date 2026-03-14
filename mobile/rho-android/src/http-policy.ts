import type { Profile } from "./models/profile.js";

export type PolicyResult =
	| { allowed: true; requiresConfirm: false }
	| { allowed: true; requiresConfirm: true; warningMessage: string }
	| { allowed: false; requiresConfirm: false; blockMessage: string };

export function evaluateHttpPolicy(
	profile: Pick<Profile, "scheme" | "host" | "name">,
): PolicyResult {
	if (profile.scheme === "https") {
		return { allowed: true, requiresConfirm: false };
	}

	const normalizedHost = profile.host.toLowerCase();

	// HTTP policy
	const isLocalhost =
		normalizedHost === "localhost" ||
		normalizedHost === "127.0.0.1" ||
		normalizedHost === "::1";
	const isLan =
		normalizedHost.startsWith("192.168.") ||
		normalizedHost.startsWith("10.") ||
		/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(normalizedHost) ||
		normalizedHost.endsWith(".local");

	if (isLocalhost) {
		return {
			allowed: true,
			requiresConfirm: true,
			warningMessage: `Connecting to localhost over HTTP is insecure but common for development. Continue connecting to ${profile.name}?`,
		};
	}

	if (isLan) {
		return {
			allowed: true,
			requiresConfirm: true,
			warningMessage: `Connecting to a local network address over HTTP is insecure. Credentials may be intercepted by others on your network. Continue connecting to ${profile.name}?`,
		};
	}

	return {
		allowed: false,
		requiresConfirm: false,
		blockMessage: `Public HTTP profiles are blocked for rho-android store builds. Use HTTPS for ${profile.name}, or connect over localhost/LAN during local development.`,
	};
}
