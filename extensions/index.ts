import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ReplacedSessionContext,
	SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
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

// ---------------------------------------------------------------------------
// Process-global coordination state
//
// In pi ≥ 0.65.0, every ctx.newSession() call recreates the DefaultResourceLoader
// and therefore produces a brand-new ExtensionRunner loaded via jiti with
// moduleCache: false.  Each fresh load calls ralph(pi) again, giving each
// session its own closure — so a plain `let` inside ralph() is NOT shared
// across sessions.
//
// We use Symbol.for() to key a single RalphState object on globalThis.  Symbols
// from Symbol.for() are shared across all module instances in the same process,
// so the state is visible to every ralph(pi) invocation regardless of how many
// times the module is freshly loaded.
//
// When the tests use a shared DefaultResourceLoader the same ExtensionRunner
// (and therefore the same ralph(pi) closure) is reused for all sessions, so
// the Symbol.for key just points to the same object — no behavioural change.
// ---------------------------------------------------------------------------

const RALPH_STATE_KEY = Symbol.for("@rahulmutt/pi-ralph.state");

interface IterationResult {
	lastMessage: string;
	messages: AgentEndEvent["messages"];
}

interface IterationSummary {
	iteration: number;
	lastMessage: string;
}

interface RalphState {
	/** Resolve for the current iteration's agentDone promise, or null when idle. */
	resolve: ((result: IterationResult) => void) | null;
	/**
	 * Prompt to send once the new session's session_start fires.
	 * Set before ctx.newSession(); consumed (and cleared) by the session_start handler.
	 */
	pending: string | null;
	/** True while a /ralph loop is actively running. */
	running: boolean;
	/** Set by /ralph stop and consumed between iterations. */
	stopRequested: boolean;
}

function getRalphState(): RalphState {
	const g = globalThis as Record<symbol, unknown>;
	if (!g[RALPH_STATE_KEY]) {
		g[RALPH_STATE_KEY] = {
			resolve: null,
			pending: null,
			running: false,
			stopRequested: false,
		} satisfies RalphState;
	}
	return g[RALPH_STATE_KEY] as RalphState;
}

function escapeCodeFence(text: string): string {
	return text.replace(/```/g, "``\\`");
}

function buildRalphContent(
	promptPath: string,
	iteration: number,
	totalIterations: number,
	iterationSummaries: IterationSummary[],
): string {
	const sections = [
		"# RALPH",
		"",
		`- Iteration: ${iteration} of ${totalIterations}`,
		`- Prompt file: ${promptPath}`,
		`- Updated: ${new Date().toISOString()}`,
		"",
		"## Iteration progression",
		"",
	];

	for (const summary of iterationSummaries) {
		sections.push(`### Iteration ${summary.iteration}`);
		sections.push("");
		sections.push("```text");
		sections.push(escapeCodeFence(summary.lastMessage || "No text message captured for this iteration."));
		sections.push("```");
		sections.push("");
	}

	return sections.join("\n");
}

/** Returns the path to the .ralph directory for a given cwd. */
function getRalphDir(cwd: string): string {
	return path.join(cwd, ".ralph");
}

function buildLoopStatus(
	iteration: number,
	totalIterations: number,
	promptPath: string,
	phase: "resetting session" | "running prompt",
): string {
	return `Ralph Wiggum loop ${iteration}/${totalIterations}: ${phase} (${promptPath})`;
}

interface InvocationPaths {
	directory: string;
	prefix: string;
	markdownPath: string;
}

/**
 * Build per-invocation paths inside the .ralph directory.
 * Layout:
 *   .ralph/<YYYY>/<MM>/<DD>/RALPH-<HH>-<MM>-<SS>-<mmm>.md
 *   .ralph/<YYYY>/<MM>/<DD>/RALPH-<HH>-<MM>-<SS>-<mmm>-iter-<NNN>.jsonl
 *
 * The timestamp is fixed once per /ralph invocation so every iteration of the
 * same run shares the same filename prefix.
 */
function buildInvocationPaths(ralphDir: string, ts: Date): InvocationPaths {
	const y = ts.getFullYear().toString();
	const mo = String(ts.getMonth() + 1).padStart(2, "0");
	const d = String(ts.getDate()).padStart(2, "0");
	const h = String(ts.getHours()).padStart(2, "0");
	const mi = String(ts.getMinutes()).padStart(2, "0");
	const s = String(ts.getSeconds()).padStart(2, "0");
	const ms = String(ts.getMilliseconds()).padStart(3, "0");
	const directory = path.join(ralphDir, y, mo, d);
	const prefix = `RALPH-${h}-${mi}-${s}-${ms}`;
	return {
		directory,
		prefix,
		markdownPath: path.join(directory, `${prefix}.md`),
	};
}

async function writeRalphStateFile(
	cwd: string,
	invocationTimestamp: Date,
	promptPath: string,
	iteration: number,
	totalIterations: number,
	iterationSummaries: IterationSummary[],
	messages: AgentEndEvent["messages"],
): Promise<void> {
	const content = buildRalphContent(promptPath, iteration, totalIterations, iterationSummaries);
	const ralphDir = getRalphDir(cwd);
	const invocationPaths = buildInvocationPaths(ralphDir, invocationTimestamp);

	// Always-current summary: .ralph/RALPH.md (overwritten each iteration)
	await fs.mkdir(ralphDir, { recursive: true });
	await fs.writeFile(path.join(ralphDir, "RALPH.md"), content, "utf8");

	// Per-invocation log: .ralph/<YYYY>/<MM>/<DD>/RALPH-<HH>-<MM>-<SS>-<mmm>.md
	await fs.mkdir(invocationPaths.directory, { recursive: true });
	await fs.writeFile(invocationPaths.markdownPath, content, "utf8");

	// Per-iteration session history JSONL: one AgentMessage per line, alongside
	// the .md file. Each iteration gets its own file while sharing the same
	// invocation prefix.
	const jsonlPath = path.join(
		invocationPaths.directory,
		`${invocationPaths.prefix}-iter-${String(iteration).padStart(3, "0")}.jsonl`,
	);
	const jsonlContent = messages.map((msg) => JSON.stringify(msg)).join("\n") + "\n";
	await fs.writeFile(jsonlPath, jsonlContent, "utf8");
}

export default function ralph(pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// session_start — currently unused.
	//
	// In pi 0.69.x, extension instances tied to the previous session are marked
	// stale during session replacement. The /ralph command now sends the prompt
	// from newSession({ withSession }) using the fresh replacement-session
	// context instead of sending from this event handler.
	// -----------------------------------------------------------------------
	pi.on("session_start", (_event: SessionStartEvent, _ctx) => {});

	// -----------------------------------------------------------------------
	// agent_end — resolve the current iteration's agentDone promise.
	//
	// In real interactive mode this fires on runner2 (new session's runner).
	// In the shared-resource-loader test setup it fires on the same runner as
	// the command handler.  Either way we resolve via the global state.
	// -----------------------------------------------------------------------
	pi.on("agent_end", async (event, _ctx) => {
		const state = getRalphState();
		if (!state.resolve) return;

		// Extract the last assistant text from this agent run's messages.
		let lastMsg = "";
		const msgs = event.messages;
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

		const resolve = state.resolve;
		state.resolve = null;
		resolve({ lastMessage: lastMsg, messages: msgs });
	});

	pi.registerCommand("ralph", {
		description: "Run a Ralph Wiggum loop with an optional iteration count and prompt file, or stop after the current iteration with /ralph stop",
		handler: async (args, ctx) => {
			let activeCtx: ExtensionCommandContext | ReplacedSessionContext = ctx;

			if (args.trim() === "stop") {
				const state = getRalphState();
				if (!state.running) {
					ctx.ui.notify("No Ralph Wiggum loop is currently running", "warning");
					return;
				}
				state.stopRequested = true;
				ctx.ui.notify("Ralph Wiggum loop will stop after the current iteration completes", "info");
				return;
			}

			const parsed = parseRalphArgs(args);
			if (parsed.error || !parsed.promptPath) {
				ctx.ui.notify(parsed.error ?? "Usage: /ralph [iterations] <prompt-file>", "warning");
				return;
			}

			{
				const state = getRalphState();
				if (state.running) {
					ctx.ui.notify("A Ralph Wiggum loop is already running", "warning");
					return;
				}
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

			{
				const state = getRalphState();
				if (state.running) {
					ctx.ui.notify("A Ralph Wiggum loop is already running", "warning");
					return;
				}
				state.running = true;
				state.stopRequested = false;
			}

			activeCtx.ui.notify(
				`Starting Ralph Wiggum loop: ${parsed.iterations} iteration${parsed.iterations === 1 ? "" : "s"}`,
				"info",
			);

			let completedIterations = 0;
			let stoppedEarly = false;

			try {
				await activeCtx.waitForIdle();

				// Timestamp fixed once per invocation; all iterations of this run share
				// the same per-invocation file path derived from this value.
				const invocationTimestamp = new Date();

				// Capture the original session once so every iteration branches from
				// the same clean parent, regardless of command-context staleness
				// after the first newSession() call.
				const originalSession = activeCtx.sessionManager.getSessionFile();
				const iterationSummaries: IterationSummary[] = [];

				for (let i = 1; i <= parsed.iterations; i++) {
					activeCtx.ui.setStatus(
						"ralph",
						buildLoopStatus(i, parsed.iterations, resolvedPromptPath, "resetting session"),
					);

					// Set up agentDone and store the resolve in global state BEFORE
					// calling newSession(). newSession() fires session_start on the
					// new session's runner (inside bindExtensions). That handler reads
					// state.pending and calls pi.sendUserMessage on the new runner —
					// which is already bound to the new session's agent.
					const state = getRalphState();
					const agentDone = new Promise<IterationResult>((resolve) => {
						state.resolve = resolve;
					});

					const newSessionResult = await activeCtx.newSession({
						...(originalSession ? { parentSession: originalSession } : {}),
						withSession: async (replacementCtx) => {
							activeCtx = replacementCtx;
							void replacementCtx.sendUserMessage(trimmedPrompt);
						},
					});
					if (newSessionResult.cancelled) {
						activeCtx.ui.notify(`Ralph Wiggum loop cancelled before iteration ${i}`, "warning");
						return;
					}

					activeCtx.ui.setStatus(
						"ralph",
						buildLoopStatus(i, parsed.iterations, resolvedPromptPath, "running prompt"),
					);

					// agentDone is resolved by the agent_end handler above.
					// The message was already sent to the new session inside the
					// session_start handler that fired during newSession().
					const { lastMessage, messages } = await agentDone;
					iterationSummaries.push({ iteration: i, lastMessage });
					await writeRalphStateFile(
						activeCtx.cwd,
						invocationTimestamp,
						resolvedPromptPath,
						i,
						parsed.iterations,
						iterationSummaries,
						messages,
					);
					completedIterations = i;
					activeCtx.ui.notify(`Ralph iteration ${i}/${parsed.iterations} complete`, "info");

					if (i < parsed.iterations) {
						const state = getRalphState();
						if (state.stopRequested) {
							stoppedEarly = true;
							activeCtx.ui.notify(
								`Ralph Wiggum loop stopping after iteration ${i}/${parsed.iterations}`,
								"info",
							);
							break;
						}
					}
				}
			} finally {
				const state = getRalphState();
				state.resolve = null;
				state.pending = null;
				state.running = false;
				state.stopRequested = false;
				activeCtx.ui.setStatus("ralph", "");
			}

			if (stoppedEarly) {
				activeCtx.ui.notify(
					`Ralph Wiggum loop stopped after ${completedIterations} of ${parsed.iterations} iteration${parsed.iterations === 1 ? "" : "s"}`,
					"success",
				);
				return;
			}

			activeCtx.ui.notify(
				`Ralph Wiggum loop complete (${parsed.iterations} iteration${parsed.iterations === 1 ? "" : "s"})`,
				"success",
			);
		},
	});
}
