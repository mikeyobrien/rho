// Types for the page's script, which is plain JavaScript so a browser runs it as it is.
export interface PageEnv {
	document: any;
	storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
	location: { hash: string; pathname: string; search: string };
	/** `pushState`, `back` and `go` let the back gesture close the details page; without them its own back button still does. */
	history: { replaceState(state: unknown, title: string, url?: string): void; pushState?(state: unknown, title: string): void; back?(): void; go?(by: number): void };
	/** Where `popstate` is heard. */
	window?: { addEventListener(type: string, listener: (event: any) => unknown): void };
	fetch(path: string, init?: RequestInit): Promise<Response>;
	touch?: boolean;
	visible?(): boolean;
	/** The time now, in milliseconds. Default: the clock. */
	now?(): number;
	/** A smaller copy of a photo, or the photo itself when it needs none. */
	shrink?(file: Blob): Promise<Blob>;
}
export function start(env: PageEnv): { ready: Promise<void>; stop(): void };
