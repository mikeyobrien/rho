const STORAGE_KEY = "rho-terminal-session-id";

export function readStoredSessionId() {
	try {
		return sessionStorage.getItem(STORAGE_KEY)?.trim() || "";
	} catch {
		return "";
	}
}

export function storeSessionId(value) {
	try {
		if (value) {
			sessionStorage.setItem(STORAGE_KEY, value);
			return;
		}
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Ignore storage failures in private/embedded contexts.
	}
}

export function buildTerminalWsUrl() {
	const url = new URL(window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/terminal/ws";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function notifyTerminalSessionsChanged() {
	window.dispatchEvent(new CustomEvent("rho:terminal-sessions-changed"));
}
