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
	selected = false;
	value = "";
	className = "";
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	#text = "";
	#classes = new Set<string>();
	classList = { toggle: (name: string, on: boolean) => void (on ? this.#classes.add(name) : this.#classes.delete(name)), contains: (name: string) => this.#classes.has(name) };
	constructor(readonly tag: string) {}
	get textContent(): string { return this.#text + this.children.map((child) => child.textContent).join(""); }
	set textContent(value: string) { this.children = []; this.#text = value; }
	append(...nodes: (El | TextNode)[]) { this.children.push(...nodes); }
	replaceChildren(...nodes: (El | TextNode)[]) { this.children = nodes; this.#text = ""; }
	addEventListener(type: string, listener: (event: any) => unknown) { (this.listeners[type] ??= []).push(listener); }
	setAttribute(name: string, value: string) { this.attrs[name] = value; }
	contains(other: unknown): boolean { return this === other || this.children.some((child) => child instanceof El && child.contains(other)); }
	async fire(type: string, event: object = {}) { for (const listener of this.listeners[type] ?? []) await listener({ preventDefault() {}, target: this, ...event }); }
	requestSubmit() { return this.fire("submit"); }
	click() { return this.fire("click"); }
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
	const hiddenAtStart = new Set(["earlier", "empty", "latest", "notice", "menu"]);
	return {
		visibilityState: "visible",
		getElementById(id: string) {
			if (!byId.has(id)) byId.set(id, Object.assign(new El(id), { hidden: hiddenAtStart.has(id) }));
			return byId.get(id)!;
		},
		createElement: (tag: string) => new El(tag),
		createTextNode: (text: string) => new TextNode(text),
		addEventListener: (type: string, listener: (event: any) => unknown) => void (listeners[type] ??= []).push(listener),
		async fire(type: string, event: object = {}) { for (const listener of listeners[type] ?? []) await listener(event); },
	};
}
export const tags = (node: El | TextNode): string[] => [node.tag, ...(node instanceof El ? node.children.flatMap(tags) : [])];
