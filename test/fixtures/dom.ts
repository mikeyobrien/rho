// A stand-in DOM: enough to run the page's real script and markdown reader and to prove what
// they create. It has no innerHTML, so the code under test cannot parse markup even by mistake.
// It does not prove layout or anything a real browser adds.
export class El {
	children: (El | TextNode)[] = [];
	listeners: Record<string, ((event: any) => unknown)[]> = {};
	attrs: Record<string, string> = {};
	style: Record<string, string> = {};
	hidden = false;
	open = false;
	disabled = false;
	inert = false;
	selected = false;
	value = "";
	/** A text box's cursor, as a browser keeps it; unset elsewhere. */
	selectionStart: number | undefined;
	setSelectionRange(start: number) { this.selectionStart = start; }
	className = "";
	id = "";
	/** The element that was last given the focus, in any document: a test reads it after an action. */
	static focused: El | undefined;
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	#text = "";
	#classes = new Set<string>();
	classList = { toggle: (name: string, on: boolean) => void (on ? this.#classes.add(name) : this.#classes.delete(name)), contains: (name: string) => this.#classes.has(name) };
	constructor(readonly tag: string) {}
	get tagName(): string { return this.tag.toUpperCase(); }
	get textContent(): string { return this.#text + this.children.map((child) => child.textContent).join(""); }
	set textContent(value: string) { this.children = []; this.#text = value; }
	append(...nodes: (El | TextNode)[]) { this.children.push(...nodes); }
	replaceChildren(...nodes: (El | TextNode)[]) { this.children = nodes; this.#text = ""; }
	addEventListener(type: string, listener: (event: any) => unknown) { (this.listeners[type] ??= []).push(listener); }
	setAttribute(name: string, value: string) { this.attrs[name] = value; }
	contains(other: unknown): boolean { return this === other || this.children.some((child) => child === other || (child instanceof El && child.contains(other))); }
	async fire(type: string, event: object = {}) { for (const listener of this.listeners[type] ?? []) await listener({ preventDefault() {}, target: this, ...event }); }
	requestSubmit() { return this.fire("submit"); }
	click() { return this.fire("click"); }
	focus() { El.focused = this; }
	/** The element last scrolled to, in any document. */
	static scrolled: El | undefined;
	scrollIntoView() { El.scrolled = this; }
	/** The element below this one that has this id, as a page that built it would find it. */
	find(id: string): El | undefined { return this.all().find((node) => node.id === id); }
	/** Every element below this one, in order. */
	all(): El[] { return this.children.flatMap((child) => (child instanceof El ? [child, ...child.all()] : [])); }
}
export class TextNode {
	readonly tag = "#text";
	constructor(public textContent: string) {}
}
export function fakeDocument() {
	const byId = new Map<string, El>();
	const listeners: Record<string, ((event: any) => unknown)[]> = {};
	// The selection, as the Selection API shows it: what is selected, and in which node it starts and ends.
	const selection = {
		text: "", anchorNode: null as unknown, focusNode: null as unknown,
		get isCollapsed() { return this.text === ""; },
		toString() { return this.text; },
		removeAllRanges() { Object.assign(selection, { text: "", anchorNode: null, focusNode: null }); },
	};
	const hiddenAtStart = new Set(["reply", "earlier", "empty", "latest", "notice", "details", "details-notice", "release", "workers", "worker-thread"]);
	return {
		visibilityState: "visible",
		getElementById(id: string) {
			if (!byId.has(id)) byId.set(id, Object.assign(new El(id), { id, hidden: hiddenAtStart.has(id) }));
			return byId.get(id)!;
		},
		createElement: (tag: string) => new El(tag),
		createTextNode: (text: string) => new TextNode(text),
		addEventListener: (type: string, listener: (event: any) => unknown) => void (listeners[type] ??= []).push(listener),
		async fire(type: string, event: object = {}) { for (const listener of listeners[type] ?? []) await listener(event); },
		getSelection: () => selection,
		/** Select `text` within `node` (and to `end`, when it ends elsewhere), and tell the page as a browser would. */
		async select(text: string, node: unknown, end: unknown = node) {
			Object.assign(selection, { text, anchorNode: node, focusNode: end });
			await this.fire("selectionchange");
		},
	};
}
/**
 * A stand-in for the browser's history and the window that hears it move. `depth` is how many
 * steps the page has pushed and not gone back over. As in a browser, going back is heard a
 * moment later, not inside the call.
 */
export function fakeHistory(location: { hash: string }) {
	const listeners: ((event: any) => unknown)[] = [];
	const history = {
		depth: 0,
		replaceState: () => void (location.hash = ""),
		pushState: () => void history.depth++,
		go(by: number) {
			if (by >= 0 || history.depth + by < 0) return;
			history.depth += by;
			queueMicrotask(() => listeners.forEach((listener) => listener({ state: null })));
		},
		back: () => history.go(-1),
	};
	return { history, window: { addEventListener: (type: string, listener: (event: any) => unknown) => void (type === "popstate" && listeners.push(listener)) } };
}
export const tags = (node: El | TextNode): string[] => [node.tag, ...(node instanceof El ? node.children.flatMap(tags) : [])];
