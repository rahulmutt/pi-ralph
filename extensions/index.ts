import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_RALPH_ITERATIONS = 3;
const MAX_RALPH_ITERATIONS = 1000;

function normalizeFsPath(targetPath: string, cwd: string): string {
	const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
	return path.normalize(resolved);
}

function isWithinPath(targetPath: string, allowedRoot: string): boolean {
	const relative = path.relative(allowedRoot, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canReadPath(targetPath: string, cwd: string): boolean {
	const roots = [
		path.resolve(cwd),
		path.join(os.homedir(), ".pi"),
		path.join(os.homedir(), ".local"),
	];
	const resolvedPath = normalizeFsPath(targetPath, cwd);
	return roots.some((root) => isWithinPath(resolvedPath, root));
}

function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

function parseRalphArgs(rawArgs: string): { iterations: number; promptPath?: string; error?: string } {
	const args = parseCommandArgs(rawArgs.trim());
	if (args.length === 0) {
		return { iterations: DEFAULT_RALPH_ITERATIONS, error: "Usage: /ralph [iterations] <prompt-file>" };
	}

	let iterations = DEFAULT_RALPH_ITERATIONS;
	let promptPath = "";

	if (/^\d+$/.test(args[0] ?? "")) {
		iterations = Number.parseInt(args[0]!, 10);
		promptPath = args.slice(1).join(" ");
	} else {
		promptPath = args.join(" ");
	}

	if (!promptPath) {
		return { iterations, error: "Usage: /ralph [iterations] <prompt-file>" };
	}

	if (!Number.isInteger(iterations) || iterations < 1) {
		return { iterations, promptPath, error: "Iterations must be a positive integer." };
	}

	if (iterations > MAX_RALPH_ITERATIONS) {
		return {
			iterations,
			promptPath,
			error: `Iterations must be ${MAX_RALPH_ITERATIONS} or fewer.`,
		};
	}

	return { iterations, promptPath };
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return (
				!!part &&
				typeof part === "object" &&
				"type" in part &&
				"text" in part &&
				part.type === "text" &&
				typeof part.text === "string"
			);
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function escapeCodeFence(text: string): string {
	return text.replace(/```/g, "``\\`");
}

async function writeRalphStateFile(
	cwd: string,
	promptPath: string,
	iteration: number,
	totalIterations: number,
	lastMessage: string,
): Promise<void> {
	const ralphPath = path.join(cwd, "RALPH.md");
	const content = [
		"# RALPH",
		"",
		`- Iteration: ${iteration} of ${totalIterations}`,
		`- Prompt file: ${promptPath}`,
		`- Updated: ${new Date().toISOString()}`,
		"",
		"## Last emitted message",
		"",
		"```text",
		escapeCodeFence(lastMessage || "No text message captured for this iteration."),
		"```",
		"",
	].join("\n");

	await fs.writeFile(ralphPath, content, "utf8");
}

export default function ralph(pi: ExtensionAPI) {
	// Used by /ralph to coordinate with agent_end events.
	// Set to a resolver just before pi.sendUserMessage is called each iteration;
	// cleared and resolved once agent_end fires.
	let ralphAgentDoneResolve: ((lastMessage: string) => void) | null = null;

	pi.on("agent_end", async (event, _ctx) => {
		if (!ralphAgentDoneResolve) return;

		// Extract the last assistant text from this agent run's messages.
		let lastMsg = "";
		const msgs = (event as unknown as { messages?: unknown[] }).messages ?? [];
		for (let i = msgs.length - 1; i >= 0; i--) {
			const msg = msgs[i] as { role?: string; content?: unknown } | undefined;
			if (msg?.role === "assistant") {
				const text = extractTextContent(msg.content);
				if (text) {
					lastMsg = text;
					break;
				}
			}
		}

		const resolve = ralphAgentDoneResolve;
		ralphAgentDoneResolve = null;
		resolve(lastMsg);
	});

	pi.registerCommand("ralph", {
		description: "Run a Ralph Wiggum loop with an optional iteration count and prompt file",
		handler: async (args, ctx) => {
			const parsed = parseRalphArgs(args);
			if (parsed.error || !parsed.promptPath) {
				ctx.ui.notify(parsed.error ?? "Usage: /ralph [iterations] <prompt-file>", "warning");
				return;
			}

			if (!canReadPath(parsed.promptPath, ctx.cwd)) {
				ctx.ui.notify(`Prompt file must be inside ${ctx.cwd}, ~/.pi, or ~/.local`, "error");
				return;
			}

			const resolvedPromptPath = normalizeFsPath(parsed.promptPath, ctx.cwd);
			let promptText = "";
			try {
				promptText = await fs.readFile(resolvedPromptPath, "utf8");
			} catch (error) {
				ctx.ui.notify(
					`Failed to read prompt file: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const trimmedPrompt = promptText.trim();
			if (!trimmedPrompt) {
				ctx.ui.notify("Prompt file is empty", "warning");
				return;
			}

			ctx.ui.notify(
				`Starting Ralph Wiggum loop: ${parsed.iterations} iteration${parsed.iterations === 1 ? "" : "s"}`,
				"info",
			);

			try {
				await ctx.waitForIdle();

				// Capture the original session once so every iteration branches from
				// the same clean parent, regardless of ctx.sessionManager staleness
				// after the first ctx.newSession() call.
				const originalSession = ctx.sessionManager.getSessionFile();

				for (let i = 1; i <= parsed.iterations; i++) {
					ctx.ui.setStatus("ralph", `Ralph Wiggum loop ${i}/${parsed.iterations}: resetting session`);

					const newSessionResult = await ctx.newSession(
						originalSession ? { parentSession: originalSession } : undefined,
					);
					if (newSessionResult.cancelled) {
						ctx.ui.notify(`Ralph Wiggum loop cancelled before iteration ${i}`, "warning");
						return;
					}

					ctx.ui.setStatus("ralph", `Ralph Wiggum loop ${i}/${parsed.iterations}: running prompt`);

					// Set up the resolver BEFORE sending the message to avoid any race
					// where agent_end fires before we've created the Promise.
					const agentDone = new Promise<string>((resolve) => {
						ralphAgentDoneResolve = resolve;
					});

					// pi.sendUserMessage returns void — do NOT await it.
					// The agent_end listener above resolves agentDone once the run
					// completes and gives us the last assistant message directly.
					pi.sendUserMessage(trimmedPrompt);

					const lastMessage = await agentDone;
					await writeRalphStateFile(ctx.cwd, resolvedPromptPath, i, parsed.iterations, lastMessage);
					ctx.ui.notify(`Ralph iteration ${i}/${parsed.iterations} complete`, "info");
				}
			} finally {
				ralphAgentDoneResolve = null;
				ctx.ui.setStatus("ralph", "");
			}

			ctx.ui.notify(
				`Ralph Wiggum loop complete (${parsed.iterations} iteration${parsed.iterations === 1 ? "" : "s"})`,
				"success",
			);
		},
	});
}
