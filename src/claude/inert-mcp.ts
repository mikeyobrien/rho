// A tool inventory for the Claude Code CLI that never runs anything. Claude can ask for one of
// rho's tools; the request goes back to rho, which is the only thing that executes tools.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as unknown[];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	let request: { id?: unknown; method?: string };
	try {
		request = JSON.parse(line);
	} catch {
		continue;
	}
	if (request.id === undefined) continue;
	const result =
		request.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "rho-tools", version: "1" } }
		: request.method === "tools/list" ? { tools }
		: request.method === "tools/call" ? { isError: true, content: [{ type: "text", text: "Not run here: rho runs its own tools." }] }
		: {};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
