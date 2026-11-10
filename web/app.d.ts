// Types for the page's script, which is plain JavaScript so a browser runs it as it is.
export interface PageEnv {
	document: any;
	storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
	location: { hash: string; pathname: string; search: string };
	history: { replaceState(state: unknown, title: string, url?: string): void };
	fetch(path: string, init?: RequestInit): Promise<Response>;
	touch?: boolean;
	visible?(): boolean;
}
export function start(env: PageEnv): { ready: Promise<void>; stop(): void };
