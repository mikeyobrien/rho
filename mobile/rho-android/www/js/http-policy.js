function parseIpv4(host) {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
		return null;
	}
	const octets = host.split(".").map((part) => Number.parseInt(part, 10));
	return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}
function isLocalhostHost(host) {
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
function isLanHost(host) {
	const ipv4 = parseIpv4(host);
	if (ipv4) {
		const [first, second] = ipv4;
		return (
			first === 10 ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168)
		);
	}
	return host.endsWith(".local");
}
function isTailscaleHost(host) {
	if (host.endsWith(".ts.net")) {
		return true;
	}
	const ipv4 = parseIpv4(host);
	if (ipv4) {
		const [first, second] = ipv4;
		return first === 100 && second >= 64 && second <= 127;
	}
	return /^[a-z0-9-]+$/.test(host) && /[a-z]/.test(host) && !host.includes(".");
}
export function evaluateHttpPolicy(profile) {
	if (profile.scheme === "https") {
		return { allowed: true, requiresConfirm: false };
	}
	const normalizedHost = profile.host.trim().toLowerCase();
	if (isLocalhostHost(normalizedHost)) {
		return {
			allowed: true,
			requiresConfirm: true,
			warningMessage: `Connecting to localhost over HTTP is insecure but common for development. Continue connecting to ${profile.name}?`,
		};
	}
	if (isLanHost(normalizedHost)) {
		return {
			allowed: true,
			requiresConfirm: true,
			warningMessage: `Connecting to a local network address over HTTP is insecure. Credentials may be intercepted by others on your network. Continue connecting to ${profile.name}?`,
		};
	}
	if (isTailscaleHost(normalizedHost)) {
		return {
			allowed: true,
			requiresConfirm: true,
			warningMessage: `Connecting to a Tailscale/private network host over HTTP is allowed, but only because the address appears tailnet-local. Continue connecting to ${profile.name}?`,
		};
	}
	return {
		allowed: false,
		requiresConfirm: false,
		blockMessage: `Public HTTP profiles are blocked for rho-android store builds. Use HTTPS for ${profile.name}, or connect over localhost, LAN, or Tailscale/private-network hosts you control.`,
	};
}
