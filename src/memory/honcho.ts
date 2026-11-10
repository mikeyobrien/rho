// The Honcho provider: what Honcho has concluded about the person is read into the memory
// section, and each finished turn is mirrored into Honcho so it has something to reason about.
// Fail-open both ways: a slow or unreachable Honcho costs an empty section or a log line.
//
// Checked against Honcho API 3.0.11:
//   read     GET  /v3/workspaces/<ws>/peers/<user>/context
//   session  POST /v3/workspaces/<ws>/sessions            (get or create, with its peers)
//   capture  POST /v3/workspaces/<ws>/sessions/<id>/messages
import type { MemoryProvider, MemoryTurn } from "./provider.ts";

export interface HonchoMemoryConfig {
	url: string;
	workspace?: string;
	/** The person's peer. */
	user?: string;
	/** Rho's peer. */
	agent?: string;
	/** Mirror each turn into Honcho. Default true. */
	capture?: boolean;
	apiKey?: string;
	maxChars?: number;
}
const READ_TIMEOUT_MS = 3_000;
const WRITE_TIMEOUT_MS = 5_000;
const MAX_READ_CHARS = 6_000;
const MAX_TURN_CHARS = 8_000;

/** The context answer as prompt text: the card, then the conclusions. Honcho lists conclusions oldest first, so when they do not fit, the newest are kept and the cut is said. */
export function honchoText(body: unknown, maxChars = MAX_READ_CHARS): string {
	if (typeof body !== "object" || body === null) return "";
	const { peer_card: card, representation } = body as { peer_card?: unknown; representation?: unknown };
	const lines = Array.isArray(card) ? card.filter((line): line is string => typeof line === "string" && line.trim() !== "") : [];
	const cardText = lines.length > 0 ? `Card:\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
	let rest = typeof representation === "string" ? representation.trim() : "";
	const room = maxChars - cardText.length - (cardText ? 2 : 0);
	if (rest.length > room) {
		const note = "(older conclusions left out)";
		const kept: string[] = [];
		let used = note.length + 1;
		for (const line of rest.split("\n").reverse()) {
			if (used + line.length + 1 > room) break;
			kept.unshift(line);
			used += line.length + 1;
		}
		rest = kept.length > 0 ? `${note}\n${kept.join("\n").trim()}` : "";
	}
	return [cardText, rest].filter((part) => part !== "").join("\n\n").slice(0, maxChars);
}

export function honchoMemory(config: HonchoMemoryConfig, host: { log?: (line: string) => void; fetch?: typeof fetch } = {}): MemoryProvider & { idle(): Promise<void> } {
	const send = host.fetch ?? fetch;
	const log = host.log ?? (() => {});
	const user = config.user ?? "user";
	const agent = config.agent ?? "rho";
	const base = `${config.url.replace(/\/+$/, "")}/v3/workspaces/${config.workspace ?? "default"}`;
	const headers = { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) };
	const known = new Set<string>(); // sessions the server has; a failed create is tried again next turn
	const queues = new Map<string, Promise<void>>(); // per session, in order: a reply never lands before its question

	const post = async (path: string, body: unknown): Promise<void> => {
		const response = await send(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
		if (!response.ok) throw new Error(`honcho ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
	};
	const observe = (turn: MemoryTurn): void => {
		const text = turn.text.trim();
		if (text.length < 2 || (turn.role === "user" && text.length > MAX_TURN_CHARS)) return; // too small to be a thought, too big to mirror
		const sessionId = `${agent}-${turn.conversationId}`;
		const next = (queues.get(sessionId) ?? Promise.resolve())
			.then(async () => {
				if (!known.has(sessionId)) {
					// The person is modelled; rho watches the person and is not modelled itself.
					await post("/sessions", { id: sessionId, peers: { [user]: { observe_me: true, observe_others: false }, [agent]: { observe_me: false, observe_others: true } } });
					known.add(sessionId);
				}
				await post(`/sessions/${sessionId}/messages`, { messages: [{ peer_id: turn.role === "user" ? user : agent, content: text.slice(0, MAX_TURN_CHARS) }] });
			})
			.catch((error: unknown) => log(`memory: honcho capture failed: ${(error as Error)?.message ?? error}`)) // the transcript is the record
			.finally(() => void (queues.get(sessionId) === next && queues.delete(sessionId)));
		queues.set(sessionId, next);
	};
	return {
		label: `honcho: ${config.url.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "")}`,
		load: async () => {
			try {
				const response = await send(`${base}/peers/${user}/context`, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
				if (!response.ok) return undefined;
				const text = honchoText(await response.json(), config.maxChars ?? MAX_READ_CHARS);
				return `What you remember about the person (from Honcho; it may be stale or wrong, and what they say now wins):\n${text === "" ? "(nothing yet)" : text}`;
			} catch {
				return undefined; // unreachable: no section now, and the next request asks again
			}
		},
		...(config.capture === false ? {} : { observe }),
		/** Resolves when every capture in flight has settled; for tests and shutdown. */
		idle: () => Promise.all([...queues.values()]).then(() => undefined),
	};
}
