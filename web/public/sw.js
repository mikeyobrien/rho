// Rho PWA Service Worker — network-first, no pre-cache
// Always fetches from the network. Caches responses as offline fallback only.
// No pre-cache list — avoids stale assets from mismatched versioned URLs.
const CACHE_NAME = "rho-v2";

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	// Purge all old caches on activate
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
	// Skip non-GET, API, and WebSocket
	if (
		event.request.method !== "GET" ||
		new URL(event.request.url).pathname.startsWith("/api/")
	) {
		return;
	}

	// Network-first, cache as offline fallback
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				if (response.ok) {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
				}
				return response;
			})
			.catch(() => caches.match(event.request)),
	);
});
