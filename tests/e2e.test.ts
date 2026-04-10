/**
 * End-to-end tests for the pi-ralph extension.
 *
 * These tests exercise the actual extension code loaded into a real pi
 * AgentSessionRuntime wired with a faux (mock) LLM provider, so no real API
 * key is needed. Every iteration of /ralph produces a deterministic response
 * from the faux provider; the test then asserts on RALPH.md, notification
 * calls, and iteration count.
 *
 * Design notes
 * ─────────────
 * • The ralph extension coordinates across session switches by relying on a
 *   SHARED DefaultResourceLoader. When newSession() is called, pi creates a
 *   new AgentSession but re-uses the same `extensionsResult.runtime` object
 *   from the loader. `_bindExtensionCore` on the new session updates
 *   `runtime.sendUserMessage` so the still-running command handler's
 *   `pi.sendUserMessage()` is transparently redirected to the new session.
 *   Sharing the resource loader in the factory is therefore required for the
 *   extension to work correctly.
 *
 * • The test's `commandContextActions.newSession` mirrors what print-mode and
 *   interactive-mode do: call `runtime.newSession()` then rebind the session.
 *
 * • Notifications from the extension are captured via a mock `uiContext`
 *   attached through `session.bindExtensions()`.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import {
	registerFauxProvider,
	fauxAssistantMessage,
	type FauxProviderRegistration,
} from "@mariozechner/pi-ai";

// ─── constants ───────────────────────────────────────────────────────────────

const EXTENSION_PATH = resolve("/workspace/extensions/index.ts");
// An isolated agent dir so tests never read ~/.pi
const AGENT_DIR = join(tmpdir(), "pi-ralph-test-agent");

// ─── helpers ─────────────────────────────────────────────────────────────────

interface Notification {
	message: string;
	type?: "info" | "warning" | "error" | "success";
}

function makeMockUIContext(notifications: Notification[]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify(message, type) {
			notifications.push({ message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setTitle: () => {},
		setEditorText: () => {},
		custom: async () => {},
	} as unknown as ExtensionUIContext;
}

/**
 * Build a runtime + rebind helper that share ONE DefaultResourceLoader so that
 * the extension's `pi` API is correctly redirected to each new session (see
 * design note above).
 */
async function createTestRuntime(cwd: string, sessionDir: string) {
	await mkdir(AGENT_DIR, { recursive: true });

	// Create the shared services once – the same resourceLoader instance is
	// re-used for every session created by the factory below.
	const sharedServices = await createAgentSessionServices({
		cwd,
		agentDir: AGENT_DIR,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
		resourceLoaderOptions: {
			additionalExtensionPaths: [EXTENSION_PATH],
			noExtensions: false,
		},
	});

	// Collect notifications emitted by the extension.
	const notifications: Notification[] = [];
	const mockUI = makeMockUIContext(notifications);

	// The variable is mutated by rebindSession() so command context always
	// closes over the latest session reference.
	let currentSession: AgentSession = undefined!;

	const fauxProvider = registerFauxProvider();

	// The model-registry auth-check requires some credentials for every provider.
	// Set a dummy runtime key so hasConfiguredAuth(fauxModel) returns true;
	// the faux stream function never makes real HTTP requests so the value is unused.
	sharedServices.authStorage.setRuntimeApiKey(fauxProvider.models[0].provider, "dummy-faux-key");

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: sessionCwd,
		sessionManager,
		sessionStartEvent,
	}) => {
		const result = await createAgentSessionFromServices({
			services: sharedServices,
			sessionManager,
			sessionStartEvent,
			model: fauxProvider.getModel(),
			// Disable thinking – the faux model never returns thinking blocks.
			thinkingLevel: "off",
		});
		return {
			...result,
			services: sharedServices,
			diagnostics: sharedServices.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: AGENT_DIR,
		sessionManager: SessionManager.create(sessionDir),
	});

	async function rebindSession() {
		currentSession = runtime.session;
		await currentSession.bindExtensions({
			uiContext: mockUI,
			commandContextActions: {
				waitForIdle: () => currentSession.agent.waitForIdle(),
				newSession: async (opts) => {
					const result = await runtime.newSession(opts);
					if (!result.cancelled) await rebindSession();
					return result;
				},
				fork: async (entryId) => {
					const result = await runtime.fork(entryId);
					if (!result.cancelled) await rebindSession();
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, opts) => {
					const result = await currentSession.navigateTree(targetId, opts);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					const result = await runtime.switchSession(sessionPath);
					if (!result.cancelled) await rebindSession();
					return result;
				},
				reload: async () => {
					await currentSession.reload();
				},
			},
			onError: (err) => {
				console.error(`[test] Extension error (${err.extensionPath}): ${err.error}`);
			},
		});
	}

	await rebindSession();

	return { runtime, fauxProvider, notifications, getSession: () => currentSession };
}

// ─── test suite ──────────────────────────────────────────────────────────────

describe("pi-ralph extension – /ralph command", () => {
	let cwd: string;
	let sessionDir: string;

	// createAgentSessionRuntime calls process.chdir(cwd). Capture the real CWD
	// up-front so afterEach can restore it before deleting the temp dirs — otherwise
	// the next test's process.cwd() call fails with ENOENT.
	const originalCwd = process.cwd();

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "ralph-cwd-"));
		sessionDir = await mkdtemp(join(tmpdir(), "ralph-sessions-"));
	});

	afterEach(async () => {
		// Restore the process CWD to a directory that will still exist, then
		// delete the per-test temp dirs so the next test starts clean.
		try { process.chdir(originalCwd); } catch { /* ignore if already gone */ }
		await rm(cwd, { recursive: true, force: true });
		await rm(sessionDir, { recursive: true, force: true });
	});

	// ── happy-path tests ────────────────────────────────────────────────────

	it("runs the requested number of iterations and writes RALPH.md", { timeout: 30_000 }, async () => {
		const promptContent = "Say hello from iteration {{i}}";
		const promptFile = join(cwd, "prompt.md");
		await writeFile(promptFile, promptContent);

		const { runtime, fauxProvider, notifications, getSession } = await createTestRuntime(
			cwd,
			sessionDir,
		);

		const iteration1Response = "Hello from the faux LLM – iteration 1";
		const iteration2Response = "Hello from the faux LLM – iteration 2";

		// Queue one faux response per iteration.
		fauxProvider.setResponses([
			fauxAssistantMessage(iteration1Response),
			fauxAssistantMessage(iteration2Response),
		]);

		try {
			// /ralph 2 prompt.md  (2 iterations, path relative to cwd)
			await getSession().prompt("/ralph 2 prompt.md");

			// ── RALPH.md assertions ──────────────────────────────────────────
			const ralphPath = join(cwd, "RALPH.md");
			const ralphContent = await readFile(ralphPath, "utf8");

			// File must contain the section header
			assert.match(ralphContent, /^# RALPH/m);

			// Last iteration number must be present
			assert.match(ralphContent, /Iteration: 2 of 2/);

			// Prompt file path must be recorded
			assert.match(ralphContent, /prompt\.md/);

			// Last emitted message from the final iteration must appear
			assert.match(ralphContent, new RegExp(iteration2Response.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

			// ── notification assertions ──────────────────────────────────────
			// "Starting" notification
			const starting = notifications.find((n) => n.message.includes("Starting Ralph Wiggum loop"));
			assert.ok(starting, "should emit a 'Starting' notification");
			assert.equal(starting.type, "info");

			// Iteration-complete notifications (one per iteration)
			const iterNotifs = notifications.filter((n) => n.message.includes("Ralph iteration") && n.message.includes("complete"));
			assert.equal(iterNotifs.length, 2, "should emit one completion notification per iteration");

			// Final success notification
			const done = notifications.find((n) => n.message.includes("Ralph Wiggum loop complete"));
			assert.ok(done, "should emit a loop-complete notification");
			assert.equal(done.type, "success");

			// ── faux provider call count ─────────────────────────────────────
			assert.equal(fauxProvider.state.callCount, 2, "faux LLM should have been called exactly 2 times");
		} finally {
			await runtime.dispose();
		}
	});

	it("defaults to 3 iterations when no count is supplied", { timeout: 30_000 }, async () => {
		const promptContent = "Do something";
		await writeFile(join(cwd, "task.md"), promptContent);

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);

		// Queue 3 canned responses (one per default iteration).
		fauxProvider.setResponses([
			fauxAssistantMessage("iteration 1 done"),
			fauxAssistantMessage("iteration 2 done"),
			fauxAssistantMessage("iteration 3 done"),
		]);

		try {
			await getSession().prompt("/ralph task.md");

			assert.equal(
				fauxProvider.state.callCount,
				3,
				"should default to 3 iterations",
			);

			const ralphContent = await readFile(join(cwd, "RALPH.md"), "utf8");
			assert.match(ralphContent, /Iteration: 3 of 3/);
		} finally {
			await runtime.dispose();
		}
	});

	it("runs a single iteration with count 1", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "one.md"), "one-shot prompt");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);
		fauxProvider.setResponses([fauxAssistantMessage("done in one shot")]);

		try {
			await getSession().prompt("/ralph 1 one.md");

			assert.equal(fauxProvider.state.callCount, 1);

			const ralphContent = await readFile(join(cwd, "RALPH.md"), "utf8");
			assert.match(ralphContent, /Iteration: 1 of 1/);
			assert.match(ralphContent, /done in one shot/);
		} finally {
			await runtime.dispose();
		}
	});

	it("RALPH.md records the last message from each iteration (final iteration wins)", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "msg.md"), "check messages");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);

		const lastIterationMsg = "final iteration message – unique marker 9f3a";
		fauxProvider.setResponses([
			fauxAssistantMessage("earlier response – should not appear in final RALPH.md"),
			fauxAssistantMessage("middle response – should not appear in final RALPH.md"),
			fauxAssistantMessage(lastIterationMsg),
		]);

		try {
			await getSession().prompt("/ralph 3 msg.md");

			const ralphContent = await readFile(join(cwd, "RALPH.md"), "utf8");
			assert.match(ralphContent, new RegExp(lastIterationMsg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			// Earlier messages must not leak into the final RALPH.md
			assert.doesNotMatch(ralphContent, /should not appear/);
		} finally {
			await runtime.dispose();
		}
	});

	it("RALPH.md contains an updated timestamp on each iteration", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "ts.md"), "timestamp test");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);
		fauxProvider.setResponses([
			fauxAssistantMessage("r1"),
			fauxAssistantMessage("r2"),
		]);

		try {
			await getSession().prompt("/ralph 2 ts.md");
			const content = await readFile(join(cwd, "RALPH.md"), "utf8");
			// ISO-8601 timestamp must be present
			assert.match(content, /Updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		} finally {
			await runtime.dispose();
		}
	});

	it("accepts a quoted path with spaces", { timeout: 30_000 }, async () => {
		const spacedDir = join(cwd, "my prompts");
		await mkdir(spacedDir, { recursive: true });
		await writeFile(join(spacedDir, "task.md"), "prompt with spaces");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);
		fauxProvider.setResponses([fauxAssistantMessage("spaces ok")]);

		try {
			await getSession().prompt('/ralph 1 "my prompts/task.md"');
			assert.equal(fauxProvider.state.callCount, 1);
		} finally {
			await runtime.dispose();
		}
	});

	// ── error / validation tests ────────────────────────────────────────────

	it("emits a warning notification when no arguments are provided", { timeout: 30_000 }, async () => {
		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			await getSession().prompt("/ralph");

			const warning = notifications.find((n) => n.message.toLowerCase().includes("usage"));
			assert.ok(warning, "should emit a usage warning");
			assert.equal(warning.type, "warning");
		} finally {
			await runtime.dispose();
		}
	});

	it("emits a warning notification when only a count is provided (no file)", { timeout: 30_000 }, async () => {
		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			await getSession().prompt("/ralph 3");

			const warning = notifications.find((n) => n.message.toLowerCase().includes("usage"));
			assert.ok(warning, "should emit a usage warning");
			assert.equal(warning.type, "warning");
		} finally {
			await runtime.dispose();
		}
	});

	it("emits an error notification when the prompt file does not exist", { timeout: 30_000 }, async () => {
		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			await getSession().prompt("/ralph 2 nonexistent-file.md");

			const error = notifications.find(
				(n) => n.type === "error" && n.message.toLowerCase().includes("failed to read"),
			);
			assert.ok(error, "should emit a file-read-error notification");

			// Must NOT have written RALPH.md
			await assert.rejects(
				() => readFile(join(cwd, "RALPH.md"), "utf8"),
				{ code: "ENOENT" },
				"RALPH.md must not be created when the prompt file is missing",
			);
		} finally {
			await runtime.dispose();
		}
	});

	it("emits a warning notification when the prompt file is empty", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "empty.md"), "");

		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			await getSession().prompt("/ralph 2 empty.md");

			const warning = notifications.find(
				(n) => n.type === "warning" && n.message.toLowerCase().includes("empty"),
			);
			assert.ok(warning, "should emit an 'empty file' warning");
		} finally {
			await runtime.dispose();
		}
	});

	it("emits a warning notification when the prompt file is only whitespace", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "blank.md"), "   \n\t\n   ");

		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			await getSession().prompt("/ralph 1 blank.md");

			const warning = notifications.find(
				(n) => n.type === "warning" && n.message.toLowerCase().includes("empty"),
			);
			assert.ok(warning, "should treat whitespace-only file as empty");
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects a path that traverses outside the allowed roots", { timeout: 30_000 }, async () => {
		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			// Attempt path traversal to /etc/passwd (outside cwd, ~/.pi, ~/.local)
			await getSession().prompt("/ralph 1 ../../../etc/passwd");

			const error = notifications.find(
				(n) => n.type === "error" && n.message.toLowerCase().includes("must be inside"),
			);
			assert.ok(error, "should emit a path-restriction error");
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects iterations > MAX_RALPH_ITERATIONS (1000)", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "over.md"), "too many");

		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			await getSession().prompt("/ralph 1001 over.md");

			const warning = notifications.find(
				(n) => (n.type === "warning" || n.type === "error") && n.message.includes("1000"),
			);
			assert.ok(warning, "should reject iteration count > 1000");
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects a non-integer iteration count", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "bad.md"), "irrelevant");

		const { runtime, notifications, getSession } = await createTestRuntime(cwd, sessionDir);

		try {
			// "abc" is not a number so it is treated as the file path, and "abc"
			// (which doesn't exist) should trigger a file-not-found error.
			await getSession().prompt("/ralph abc bad.md");

			// The extension tries to read "abc bad.md" (joined) — or falls back to
			// reading "abc" as path. Either way an error must be surfaced.
			const hasNotification = notifications.some((n) => n.type === "error" || n.type === "warning");
			assert.ok(hasNotification, "non-numeric count should surface a warning or error");
		} finally {
			await runtime.dispose();
		}
	});

	// ── RALPH.md format tests ───────────────────────────────────────────────

	it("RALPH.md contains the correct section structure", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "fmt.md"), "format check prompt");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);
		fauxProvider.setResponses([fauxAssistantMessage("format response")]);

		try {
			await getSession().prompt("/ralph 1 fmt.md");

			const content = await readFile(join(cwd, "RALPH.md"), "utf8");

			// Required structural elements
			assert.match(content, /^# RALPH\s*$/m, "must have '# RALPH' header");
			assert.match(content, /^- Iteration:/m, "must have Iteration line");
			assert.match(content, /^- Prompt file:/m, "must have Prompt file line");
			assert.match(content, /^- Updated:/m, "must have Updated line");
			assert.match(content, /^## Last emitted message\s*$/m, "must have last-message section");
			assert.match(content, /```text/, "must use a text code fence");
		} finally {
			await runtime.dispose();
		}
	});

	it("RALPH.md escapes code-fence markers inside the last message", { timeout: 30_000 }, async () => {
		await writeFile(join(cwd, "fence.md"), "fence test");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);
		// Response contains a triple-backtick that must be escaped.
		fauxProvider.setResponses([
			fauxAssistantMessage('Here is code:\n```javascript\nconsole.log("hi");\n```\nDone.'),
		]);

		try {
			await getSession().prompt("/ralph 1 fence.md");

			const content = await readFile(join(cwd, "RALPH.md"), "utf8");
			// The raw ``` inside the response must be escaped so the file is valid
			assert.match(content, /``\\`/, "triple-backtick should be escaped as ``\\`");
		} finally {
			await runtime.dispose();
		}
	});

	// ── path resolution tests ───────────────────────────────────────────────

	it("resolves relative paths against cwd", { timeout: 30_000 }, async () => {
		const subDir = join(cwd, "subdir");
		await mkdir(subDir, { recursive: true });
		await writeFile(join(subDir, "relative.md"), "relative path test");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);
		fauxProvider.setResponses([fauxAssistantMessage("relative ok")]);

		try {
			await getSession().prompt("/ralph 1 subdir/relative.md");
			assert.equal(fauxProvider.state.callCount, 1, "relative path should resolve");
		} finally {
			await runtime.dispose();
		}
	});

	it("resolves absolute paths inside cwd", { timeout: 30_000 }, async () => {
		const absPrompt = join(cwd, "absolute.md");
		await writeFile(absPrompt, "absolute path test");

		const { runtime, fauxProvider, getSession } = await createTestRuntime(cwd, sessionDir);
		fauxProvider.setResponses([fauxAssistantMessage("absolute ok")]);

		try {
			await getSession().prompt(`/ralph 1 ${absPrompt}`);
			assert.equal(fauxProvider.state.callCount, 1, "absolute path inside cwd should resolve");
		} finally {
			await runtime.dispose();
		}
	});
});
