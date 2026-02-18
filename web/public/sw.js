// Rho PWA Service Worker — network-first with offline fallback
// Strategy: always try network first so code changes propagate immediately.
// Cache responses as a fallback for when the server is unreachable.
const CACHE_NAME = "rho-v1";

// Pre-cache the app shell on install for offline cold-start
const SHELL_ASSETS = [
	"/",
	"/css/style.css",
	"/js/app.js",
	"/js/chat.js",
	"/js/config.js",
	"/js/memory.js",
	"/js/slash-contract.js",
	"/favicon.svg",
	"/manifest.json",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
				),
			),
	);
	self.clients.claim();
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);

	// Skip non-GET, API calls, and WebSocket upgrades
	if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) {
		return;
	}

	// Everything else: network-first, cache as fallback
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				// Only cache successful responses
				if (response.ok) {
					const clone = response.clone();
					caches
						.open(CACHE_NAME)
						.then((cache) => cache.put(event.request, clone));
				}
				return response;
			})
			.catch(() => caches.match(event.request)),
	);
});
