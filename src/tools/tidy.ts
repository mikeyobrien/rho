// Tidy tools: every tool takes an optional `reasoning` argument, a short phrase saying why the
// call is made. The tool never reads it. It is for the person: the page shows it as the first
// line of the call's card, so a run reads as a list of intentions and not a wall of commands.
import type { Extension } from "@earendil-works/pi-durable";

const REASONING = { type: "string", description: "A short phrase (12 words at most) stating the goal behind this call: the why in context, not a restatement of the arguments." };

/** The extension with `reasoning` added to each of its tools that does not already declare it. */
export function tidy(extension: Extension): Extension {
	if (!extension.tools?.length) return extension;
	return {
		...extension,
		tools: extension.tools.map((tool) => {
			const parameters = tool.parameters as { properties?: Record<string, unknown> };
			if (parameters.properties?.reasoning !== undefined) return tool;
			return { ...tool, parameters: { ...parameters, properties: { ...parameters.properties, reasoning: REASONING } } };
		}),
	};
}
