import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";

type RunResult = {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

type RunOptions = {
	cwd?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
};

type Gate = {
	name: string;
	slug: string;
	timeoutMs: number;
	script: (baseUrl: string) => string;
};

type FakeSessionState = {
	id: string;
	sessionFile: string;
	handlers: Set<(event: Record<string, unknown>) => void>;
	isStreaming: boolean;
	timers: Set<NodeJS.Timeout>;
};

type RpcManagerLike = {
	startSession: (sessionFile: string) => string;
	findSessionByFile: (sessionFile: string) => string | null;
	onEvent: (
		sessionId: string,
		handler: (event: Record<string, unknown>) => void,
	) => () => void;
	sendCommand: (sessionId: string, command: Record<string, unknown>) => void;
	hasSubscribers: (sessionId: string) => boolean;
	stopSession: (sessionId: string) => void;
	dispose: () => void;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function extractSessionId(output: string): string {
	const trimmed = output.trim();
	if (!trimmed) {
		return "";
	}
	const lines = trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				reject(new Error("Failed to allocate free port"));
				return;
			}
			const { port } = address;
			probe.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			});
		});
	});
}

function runProcess(
	command: string,
	args: string[],
	options: RunOptions = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let timeout: NodeJS.Timeout | null = null;

		if (child.stdout) {
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
		}
		if (child.stderr) {
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
		}

		child.on("error", (error) => {
			if (timeout) {
				clearTimeout(timeout);
			}
			reject(error);
		});

		child.on("close", (code) => {
			if (timeout) {
				clearTimeout(timeout);
			}
			resolve({
				code: typeof code === "number" ? code : 1,
				stdout,
				stderr,
				timedOut,
			});
		});

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs);
		}
	});
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const response = await fetch(url, { method: "GET" });
			if (response.ok) {
				return;
			}
		} catch {
			// Ignore while waiting for boot.
		}
		await sleep(120);
	}
	throw new Error(`Timed out waiting for server readiness at ${url}`);
}

function installFakeRpcManager(rpcManager: RpcManagerLike): {
	restore: () => void;
} {
	const originalMethods = {
		startSession: rpcManager.startSession.bind(rpcManager),
		findSessionByFile: rpcManager.findSessionByFile.bind(rpcManager),
		onEvent: rpcManager.onEvent.bind(rpcManager),
		sendCommand: rpcManager.sendCommand.bind(rpcManager),
		hasSubscribers: rpcManager.hasSubscribers.bind(rpcManager),
		stopSession: rpcManager.stopSession.bind(rpcManager),
		dispose: rpcManager.dispose.bind(rpcManager),
	};

	const sessionsById = new Map<string, FakeSessionState>();
	const sessionByFile = new Map<string, string>();
	let nextSession = 0;

	function emit(sessionId: string, event: Record<string, unknown>): void {
		const state = sessionsById.get(sessionId);
		if (!state) {
			return;
		}
		if (event.type === "agent_start") {
			state.isStreaming = true;
		}
		if (event.type === "agent_end") {
			state.isStreaming = false;
		}
		for (const handler of state.handlers) {
			handler(event);
		}
	}

	function schedule(
		state: FakeSessionState,
		delayMs: number,
		fn: () => void,
	): void {
		const timer = setTimeout(() => {
			state.timers.delete(timer);
			fn();
		}, delayMs);
		state.timers.add(timer);
	}

	function buildStateResponse(
		state: FakeSessionState,
	): Record<string, unknown> {
		return {
			model: "playwriter-fake-model",
			thinkingLevel: "medium",
			isStreaming: state.isStreaming,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionFile: state.sessionFile,
			sessionId: state.id,
			sessionName: null,
			autoCompactionEnabled: false,
			messageCount: 0,
			pendingMessageCount: 0,
		};
	}

	rpcManager.startSession = (sessionFile: string): string => {
		nextSession += 1;
		const id = `fake-rpc-${nextSession}`;
		const state: FakeSessionState = {
			id,
			sessionFile,
			handlers: new Set(),
			isStreaming: false,
			timers: new Set(),
		};
		sessionsById.set(id, state);
		sessionByFile.set(sessionFile, id);
		return id;
	};

	rpcManager.findSessionByFile = (sessionFile: string): string | null => {
		const sessionId = sessionByFile.get(sessionFile);
		if (!sessionId) {
			return null;
		}
		return sessionsById.has(sessionId) ? sessionId : null;
	};

	rpcManager.onEvent = (
		sessionId: string,
		handler: (event: Record<string, unknown>) => void,
	): (() => void) => {
		const state = sessionsById.get(sessionId);
		if (!state) {
			throw new Error(`Unknown fake session: ${sessionId}`);
		}
		state.handlers.add(handler);
		return () => {
			state.handlers.delete(handler);
		};
	};

	rpcManager.sendCommand = (
		sessionId: string,
		command: Record<string, unknown>,
	): void => {
		const state = sessionsById.get(sessionId);
		if (!state) {
			throw new Error(`Unknown fake session: ${sessionId}`);
		}

		const commandType = String(command.type ?? "");
		const commandId =
			typeof command.id === "string" && command.id.trim().length > 0
				? command.id.trim()
				: `fake-cmd-${Date.now()}`;

		if (commandType === "get_state") {
			emit(sessionId, {
				type: "response",
				command: "get_state",
				id: commandId,
				success: true,
				data: buildStateResponse(state),
			});
			return;
		}

		if (commandType === "abort") {
			emit(sessionId, {
				type: "response",
				command: "abort",
				id: commandId,
				success: true,
			});
			state.isStreaming = false;
			return;
		}

		if (commandType !== "prompt") {
			emit(sessionId, {
				type: "response",
				command: commandType || "unknown",
				id: commandId,
				success: true,
			});
			return;
		}

		const promptText =
			typeof command.message === "string" && command.message.trim().length > 0
				? command.message.trim()
				: "prompt";
		const responseText = `assistant(${sessionId}): ${promptText}`;
		const messageId = `assistant-${commandId}`;

		emit(sessionId, {
			type: "response",
			command: "prompt",
			id: commandId,
			success: true,
		});

		schedule(state, 10, () => emit(sessionId, { type: "agent_start" }));
		schedule(state, 40, () =>
			emit(sessionId, {
				type: "message_start",
				message: {
					id: messageId,
					role: "assistant",
					timestamp: new Date().toISOString(),
					content: [],
				},
			}),
		);
		schedule(state, 90, () =>
			emit(sessionId, {
				type: "message_end",
				message: {
					id: messageId,
					role: "assistant",
					timestamp: new Date().toISOString(),
					content: [{ type: "text", text: responseText }],
				},
			}),
		);
		schedule(state, 220, () => emit(sessionId, { type: "agent_end" }));
	};

	rpcManager.hasSubscribers = (sessionId: string): boolean => {
		const state = sessionsById.get(sessionId);
		return Boolean(state && state.handlers.size > 0);
	};

	rpcManager.stopSession = (sessionId: string): void => {
		const state = sessionsById.get(sessionId);
		if (!state) {
			return;
		}
		for (const timer of state.timers) {
			clearTimeout(timer);
		}
		sessionsById.delete(sessionId);
		sessionByFile.delete(state.sessionFile);
	};

	rpcManager.dispose = (): void => {
		for (const sessionId of [...sessionsById.keys()]) {
			rpcManager.stopSession(sessionId);
		}
	};

	return {
		restore: () => {
			rpcManager.startSession = originalMethods.startSession;
			rpcManager.findSessionByFile = originalMethods.findSessionByFile;
			rpcManager.onEvent = originalMethods.onEvent;
			rpcManager.sendCommand = originalMethods.sendCommand;
			rpcManager.hasSubscribers = originalMethods.hasSubscribers;
			rpcManager.stopSession = originalMethods.stopSession;
			rpcManager.dispose = originalMethods.dispose;
		},
	};
}

async function createPlaywriterSession(cwd: string): Promise<string> {
	const result = await runProcess("playwriter", ["session", "new"], {
		cwd,
		timeoutMs: 20_000,
	});
	if (result.code !== 0) {
		throw new Error(
			`playwriter session new failed (code ${result.code})\n${result.stdout}\n${result.stderr}`,
		);
	}
	const sessionId = extractSessionId(result.stdout || result.stderr);
	if (!sessionId) {
		throw new Error(
			`playwriter session new returned empty session id\n${result.stdout}\n${result.stderr}`,
		);
	}
	return sessionId;
}

async function runPlaywriterEval(
	cwd: string,
	sessionId: string,
	script: string,
	timeoutMs: number,
): Promise<RunResult> {
	return await runProcess(
		"playwriter",
		["-s", sessionId, "--timeout", String(timeoutMs), "-e", script],
		{
			cwd,
			timeoutMs: timeoutMs + 10_000,
		},
	);
}

async function captureFailureArtifacts(
	cwd: string,
	sessionId: string,
	gateDir: string,
): Promise<void> {
	mkdirSync(gateDir, { recursive: true });
	const screenshotPath = path.join(gateDir, "failure.png");
	const browserLogsPath = path.join(gateDir, "browser-logs.json");
	const captureScript = `
const fs = require("node:fs");
if (!state.page) {
	console.log("No page available for artifact capture.");
	return;
}
try {
	await state.page.screenshot({
		path: ${JSON.stringify(screenshotPath)},
		fullPage: true,
		scale: "css",
	});
} catch (error) {
	console.log("Screenshot capture failed: " + String(error));
}
try {
	const logs = await getLatestLogs({ page: state.page });
	fs.writeFileSync(
		${JSON.stringify(browserLogsPath)},
		JSON.stringify(logs, null, 2),
		"utf8",
	);
} catch (error) {
	fs.writeFileSync(
		${JSON.stringify(browserLogsPath)},
		JSON.stringify([{ level: "error", text: String(error) }], null, 2),
		"utf8",
	);
}
console.log("Captured failure artifacts.");
`;
	await runPlaywriterEval(cwd, sessionId, captureScript, 25_000);
}

function gateReloadRestoreScript(baseUrl: string): string {
	return `
const baseUrl = ${JSON.stringify(baseUrl)};
state.page = await context.newPage();
await state.page.goto(baseUrl, { waitUntil: "networkidle" });

const setup = await state.page.evaluate(async () => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (check, timeoutMs, label) => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (check()) {
				return;
			}
			await sleep(25);
		}
		throw new Error("Timed out waiting for " + label);
	};
	const getVm = () => {
		const root = document.querySelector(".view-body[x-data]");
		if (!root || !window.Alpine || typeof window.Alpine.$data !== "function") {
			throw new Error("rhoChat Alpine vm unavailable");
		}
		return window.Alpine.$data(root);
	};
	const vm = getVm();

	await waitFor(() => vm.isWsConnected === true, 8000, "websocket connection");

	const createSession = async () => {
		const response = await fetch("/api/sessions/new", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		if (!response.ok) {
			throw new Error("Failed creating session: " + response.status);
		}
		return await response.json();
	};

	const createInteractiveSession = async (index) => {
		const created = await createSession();
		const sessionId = String(created.sessionId || "");
		const sessionFile = String(created.sessionFile || "");
		if (!sessionId || !sessionFile) {
			throw new Error("Session create response missing identifiers");
		}
		vm.ensureSessionState(sessionId, { sessionFile });
		vm.startRpcSession(sessionFile, { sessionId });
		await waitFor(() => {
			const state = vm.ensureSessionState(sessionId);
			return Boolean(
				state &&
					typeof state.rpcSessionId === "string" &&
					state.rpcSessionId.length > 0,
			);
		}, 7000, "rpc startup for session " + index);
		return {
			sessionId,
			sessionFile,
			draft: "gate-1-draft-" + index,
		};
	};

	const created = [];
	for (let index = 1; index <= 5; index += 1) {
		created.push(await createInteractiveSession(index));
	}

	for (const session of created) {
		const state = vm.ensureSessionState(session.sessionId, {
			sessionFile: session.sessionFile,
		});
		state.promptText = session.draft;
	}

	const focusSessionId = created[2].sessionId;
	vm.activeSessionId = focusSessionId;
	vm.persistSessionRestoreSnapshot();
	await sleep(100);

	const snapshotRaw = localStorage.getItem(vm.sessionRestoreStorageKey);
	const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;

	return {
		created,
		focusSessionId,
		activeIdsBeforeReload: Array.isArray(snapshot?.activeSessionIds)
			? snapshot.activeSessionIds
			: [],
	};
});

await state.page.reload({ waitUntil: "networkidle" });

const verification = await state.page.evaluate(async (setup) => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (check, timeoutMs, label) => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (check()) {
				return;
			}
			await sleep(25);
		}
		throw new Error("Timed out waiting for " + label);
	};
	const getVm = () => {
		const root = document.querySelector(".view-body[x-data]");
		if (!root || !window.Alpine || typeof window.Alpine.$data !== "function") {
			throw new Error("rhoChat Alpine vm unavailable");
		}
		return window.Alpine.$data(root);
	};
	const vm = getVm();

	await waitFor(() => vm.isWsConnected === true, 8000, "post-reload websocket");
	await waitFor(() => {
		return setup.created.every((session) => {
			const state = vm.ensureSessionState(session.sessionId);
			return (
				Boolean(state) &&
				typeof state.promptText === "string" &&
				state.promptText === session.draft
			);
		});
	}, 9000, "draft restoration");
	await waitFor(() => {
		return setup.created.every((session) => {
			const state = vm.ensureSessionState(session.sessionId);
			return (
				Boolean(state) &&
				typeof state.rpcSessionId === "string" &&
				state.rpcSessionId.length > 0
			);
		});
	}, 12000, "active runtime restoration");

	const focusRestored = vm.activeSessionId === setup.focusSessionId;
	const draftsRestored = setup.created.every((session) => {
		const state = vm.ensureSessionState(session.sessionId);
		return state && state.promptText === session.draft;
	});
	const runtimeRestoredCount = setup.created.filter((session) => {
		const state = vm.ensureSessionState(session.sessionId);
		return Boolean(state?.rpcSessionId);
	}).length;

	const snapshotRaw = localStorage.getItem(vm.sessionRestoreStorageKey);
	const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;
	const activeIdsAfterReload = Array.isArray(snapshot?.activeSessionIds)
		? snapshot.activeSessionIds
		: [];

	const pass =
		setup.activeIdsBeforeReload.length === 5 &&
		focusRestored &&
		draftsRestored &&
		runtimeRestoredCount === 5 &&
		activeIdsAfterReload.length >= 5;

	return {
		gate: "reload-restore",
		focusRestored,
		draftsRestored,
		runtimeRestoredCount,
		activeIdsBeforeReload: setup.activeIdsBeforeReload.length,
		activeIdsAfterReload: activeIdsAfterReload.length,
		pass,
	};
}, setup);

if (!verification.pass) {
	throw new Error("Gate reload-restore failed: " + JSON.stringify(verification));
}

console.log("GATE_RESULT " + JSON.stringify(verification));
`;
}

function gateConcurrencyIntegrityScript(baseUrl: string): string {
	return `
const baseUrl = ${JSON.stringify(baseUrl)};
state.page = await context.newPage();
await state.page.goto(baseUrl, { waitUntil: "networkidle" });

const result = await state.page.evaluate(async () => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (check, timeoutMs, label) => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (check()) {
				return;
			}
			await sleep(25);
		}
		throw new Error("Timed out waiting for " + label);
	};
	const getVm = () => {
		const root = document.querySelector(".view-body[x-data]");
		if (!root || !window.Alpine || typeof window.Alpine.$data !== "function") {
			throw new Error("rhoChat Alpine vm unavailable");
		}
		return window.Alpine.$data(root);
	};
	const flattenStateText = (state) => {
		if (!state || !Array.isArray(state.renderedMessages)) {
			return "";
		}
		const chunks = [];
		for (const message of state.renderedMessages) {
			if (!message || !Array.isArray(message.parts)) {
				continue;
			}
			for (const part of message.parts) {
				if (part?.type === "text" && typeof part.content === "string") {
					chunks.push(part.content);
				}
			}
		}
		return chunks.join("\\n").toLowerCase();
	};
	const createSession = async () => {
		const response = await fetch("/api/sessions/new", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		if (!response.ok) {
			throw new Error("Failed creating session: " + response.status);
		}
		return await response.json();
	};
	const createInteractiveSession = async (label) => {
		const vm = getVm();
		const created = await createSession();
		const sessionId = String(created.sessionId || "");
		const sessionFile = String(created.sessionFile || "");
		if (!sessionId || !sessionFile) {
			throw new Error("Session create response missing identifiers");
		}
		vm.ensureSessionState(sessionId, { sessionFile });
		vm.startRpcSession(sessionFile, { sessionId });
		await waitFor(() => {
			const state = vm.ensureSessionState(sessionId);
			return Boolean(
				state &&
					typeof state.rpcSessionId === "string" &&
					state.rpcSessionId.length > 0,
			);
		}, 7000, "rpc startup " + label);
		return { sessionId, sessionFile };
	};

	const vm = getVm();
	await waitFor(() => vm.isWsConnected === true, 8000, "websocket connection");

	const alpha = await createInteractiveSession("alpha");
	const beta = await createInteractiveSession("beta");

	vm.activeSessionId = alpha.sessionId;
	vm.promptText = "gate-two-alpha";
	vm.sendPrompt();

	await waitFor(() => {
		const state = vm.ensureSessionState(alpha.sessionId);
		return Boolean(state?.isStreaming);
	}, 5000, "alpha stream start");

	await sleep(130);
	const alphaStillStreamingAtSwitch = Boolean(
		vm.ensureSessionState(alpha.sessionId)?.isStreaming,
	);

	vm.activeSessionId = beta.sessionId;
	vm.promptText = "gate-two-beta";
	vm.sendPrompt();

	await waitFor(() => {
		const state = vm.ensureSessionState(beta.sessionId);
		return Boolean(state?.isStreaming);
	}, 5000, "beta stream start");

	await waitFor(() => {
		const alphaState = vm.ensureSessionState(alpha.sessionId);
		const betaState = vm.ensureSessionState(beta.sessionId);
		return (
			Boolean(alphaState) &&
			Boolean(betaState) &&
			!alphaState.isStreaming &&
			!betaState.isStreaming &&
			alphaState.status === "idle" &&
			betaState.status === "idle"
		);
	}, 10000, "both prompts complete");

	const textAlpha = flattenStateText(vm.ensureSessionState(alpha.sessionId));
	const textBeta = flattenStateText(vm.ensureSessionState(beta.sessionId));

	const alphaContainsAlpha = textAlpha.includes("gate-two-alpha");
	const alphaContainsBeta = textAlpha.includes("gate-two-beta");
	const betaContainsBeta = textBeta.includes("gate-two-beta");
	const betaContainsAlpha = textBeta.includes("gate-two-alpha");

	const pass =
		alphaStillStreamingAtSwitch &&
		alphaContainsAlpha &&
		betaContainsBeta &&
		!alphaContainsBeta &&
		!betaContainsAlpha;

	return {
		gate: "concurrency-integrity",
		alphaStillStreamingAtSwitch,
		alphaContainsAlpha,
		betaContainsBeta,
		alphaContainsBeta,
		betaContainsAlpha,
		pass,
	};
});

if (!result.pass) {
	throw new Error("Gate concurrency-integrity failed: " + JSON.stringify(result));
}

console.log("GATE_RESULT " + JSON.stringify(result));
`;
}

function gateBackgroundContinuityScript(baseUrl: string): string {
	return `
const baseUrl = ${JSON.stringify(baseUrl)};
state.page = await context.newPage();
await state.page.goto(baseUrl, { waitUntil: "networkidle" });

const result = await state.page.evaluate(async () => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (check, timeoutMs, label) => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (check()) {
				return;
			}
			await sleep(25);
		}
		throw new Error("Timed out waiting for " + label);
	};
	const getVm = () => {
		const root = document.querySelector(".view-body[x-data]");
		if (!root || !window.Alpine || typeof window.Alpine.$data !== "function") {
			throw new Error("rhoChat Alpine vm unavailable");
		}
		return window.Alpine.$data(root);
	};
	const createSession = async () => {
		const response = await fetch("/api/sessions/new", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		if (!response.ok) {
			throw new Error("Failed creating session: " + response.status);
		}
		return await response.json();
	};
	const createInteractiveSession = async (label) => {
		const vm = getVm();
		const created = await createSession();
		const sessionId = String(created.sessionId || "");
		const sessionFile = String(created.sessionFile || "");
		if (!sessionId || !sessionFile) {
			throw new Error("Session create response missing identifiers");
		}
		vm.ensureSessionState(sessionId, { sessionFile });
		vm.startRpcSession(sessionFile, { sessionId });
		await waitFor(() => {
			const state = vm.ensureSessionState(sessionId);
			return Boolean(
				state &&
					typeof state.rpcSessionId === "string" &&
					state.rpcSessionId.length > 0,
			);
		}, 7000, "rpc startup " + label);
		return { sessionId, sessionFile };
	};

	const vm = getVm();
	await waitFor(() => vm.isWsConnected === true, 8000, "websocket connection");

	const alpha = await createInteractiveSession("alpha");
	const beta = await createInteractiveSession("beta");

	vm.activeSessionId = alpha.sessionId;
	vm.promptText = "gate-three-alpha";
	vm.sendPrompt();

	await waitFor(() => {
		const state = vm.ensureSessionState(alpha.sessionId);
		return Boolean(state?.isStreaming);
	}, 5000, "alpha stream start");

	vm.activeSessionId = beta.sessionId;
	await waitFor(() => vm.activeSessionId === beta.sessionId, 2000, "focus beta");

	await waitFor(() => {
		const state = vm.ensureSessionState(alpha.sessionId);
		return Boolean(state?.unreadMilestone);
	}, 10000, "alpha unread milestone");

	const unreadWhileBackground = Boolean(
		vm.ensureSessionState(alpha.sessionId)?.unreadMilestone,
	);
	const alphaStatusAfterBackground =
		vm.ensureSessionState(alpha.sessionId)?.status ?? "";

	const sentPayloads = [];
	const originalSendWs = vm.sendWs.bind(vm);
	vm.sendWs = (payload, options = {}) => {
		sentPayloads.push(payload);
		return originalSendWs(payload, options);
	};

	let getStateIssued = false;
	let unreadCleared = false;
	try {
		await vm.selectSession(alpha.sessionId, { updateHash: false });
		const alphaRpcSessionId =
			vm.ensureSessionState(alpha.sessionId)?.rpcSessionId ?? "";
		await waitFor(() => {
			return sentPayloads.some((payload) => {
				return (
					payload &&
					payload.type === "rpc_command" &&
					payload.sessionId === alphaRpcSessionId &&
					payload.command &&
					payload.command.type === "get_state"
				);
			});
		}, 5000, "get_state request on refocus");
		getStateIssued = true;
		await waitFor(() => {
			const state = vm.ensureSessionState(alpha.sessionId);
			return Boolean(state && state.unreadMilestone === false);
		}, 6000, "unread clear on focused resync");
		unreadCleared = true;
	} finally {
		vm.sendWs = originalSendWs;
	}

	const pass =
		unreadWhileBackground &&
		alphaStatusAfterBackground === "idle" &&
		getStateIssued &&
		unreadCleared;

	return {
		gate: "background-continuity",
		unreadWhileBackground,
		alphaStatusAfterBackground,
		getStateIssued,
		unreadCleared,
		pass,
	};
});

if (!result.pass) {
	throw new Error("Gate background-continuity failed: " + JSON.stringify(result));
}

console.log("GATE_RESULT " + JSON.stringify(result));
`;
}

async function runGate(
	cwd: string,
	artifactRoot: string,
	baseUrl: string,
	gate: Gate,
): Promise<void> {
	console.log(`\n→ ${gate.name}`);
	const gateDir = path.join(artifactRoot, gate.slug);
	mkdirSync(gateDir, { recursive: true });

	const sessionId = await createPlaywriterSession(cwd);
	const result = await runPlaywriterEval(
		cwd,
		sessionId,
		gate.script(baseUrl),
		gate.timeoutMs,
	);

	writeFileSync(path.join(gateDir, "stdout.log"), result.stdout, "utf8");
	writeFileSync(path.join(gateDir, "stderr.log"), result.stderr, "utf8");

	if (result.code !== 0) {
		await captureFailureArtifacts(cwd, sessionId, gateDir);
		throw new Error(
			`${gate.name} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""})\n` +
				`${result.stdout}\n${result.stderr}`,
		);
	}

	const gateLine = result.stdout
		.split(/\r?\n/)
		.find((line) => line.startsWith("GATE_RESULT "));
	if (gateLine) {
		console.log(`  ${gateLine}`);
	}
	console.log(`  PASS ${gate.name}`);
}

async function main(): Promise<void> {
	const testDir =
		import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(testDir, "../..");

	const runRoot = mkdtempSync(path.join(os.tmpdir(), "rho-playwriter-gates-"));
	const homeDir = path.join(runRoot, "home");
	mkdirSync(homeDir, { recursive: true });
	process.env.HOME = homeDir;
	process.env.RHO_HOME = path.join(homeDir, ".rho");

	const artifactRoot = path.join(
		repoRoot,
		".agents",
		"artifacts",
		"playwriter-multi-session",
		nowStamp(),
	);
	mkdirSync(artifactRoot, { recursive: true });

	console.log("=== Playwriter Multi-Session Acceptance Gates ===");
	console.log(`Artifacts: ${artifactRoot}`);
	console.log(`Isolated HOME: ${homeDir}`);

	const serverModule = await import("../../web/server.ts");
	const rpcModule = await import("../../web/rpc-manager.ts");
	const app = serverModule.default;
	const injectWebSocket = serverModule.injectWebSocket as (
		server: unknown,
	) => void;
	const disposeServerResources =
		serverModule.disposeServerResources as () => void;
	const rpcManager = rpcModule.rpcManager as RpcManagerLike;

	const fakeRpc = installFakeRpcManager(rpcManager);
	const port = await getFreePort();
	const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
	injectWebSocket(server);
	const baseUrl = `http://127.0.0.1:${port}`;

	const gates: Gate[] = [
		{
			name: "Gate 1: Reload restore (5 active + drafts)",
			slug: "gate-1-reload-restore",
			timeoutMs: 180_000,
			script: gateReloadRestoreScript,
		},
		{
			name: "Gate 2: Concurrency integrity (no cross-talk)",
			slug: "gate-2-concurrency-integrity",
			timeoutMs: 150_000,
			script: gateConcurrencyIntegrityScript,
		},
		{
			name: "Gate 3: Background continuity + refocus resync",
			slug: "gate-3-background-continuity",
			timeoutMs: 150_000,
			script: gateBackgroundContinuityScript,
		},
	];

	let failed = false;
	try {
		await waitForHttpReady(`${baseUrl}/`, 8_000);
		for (const gate of gates) {
			await runGate(repoRoot, artifactRoot, baseUrl, gate);
		}
		console.log("\n✅ All Playwriter acceptance gates passed.");
	} catch (error) {
		failed = true;
		console.error("\n❌ Playwriter gate run failed.");
		console.error(error instanceof Error ? error.message : String(error));
	} finally {
		try {
			disposeServerResources();
		} catch {
			// Ignore disposal errors during teardown.
		}
		try {
			server.close();
		} catch {
			// Ignore close errors during teardown.
		}
		fakeRpc.restore();
	}

	process.exit(failed ? 1 : 0);
}

await main();
