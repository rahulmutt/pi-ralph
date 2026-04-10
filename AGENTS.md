# AGENTS.md — Guide for AI Agents

This document tells AI coding agents how to understand, navigate, build, and test this repository.

---

## What this repo is

`@rahulmutt/pi-ralph` is a **[pi](https://github.com/badlogic/pi) extension** that adds a single slash-command, `/ralph`, to the pi coding agent.

The `/ralph` command implements a "Ralph Wiggum loop": it runs the contents of a prompt file as a user message, repeatedly, across a configurable number of fresh agent sessions. Each iteration branches from the original session so context is always clean.

```
/ralph [iterations] <prompt-file>
/ralph 5 prompts/implement.md
```

---

## Repository layout

```
extensions/
  index.ts          # The entire extension — single source file
tests/
  e2e.test.ts       # End-to-end test suite (faux LLM, no API key needed)
package.json        # npm package manifest; also declares the pi extension entry
.devcontainer/      # Dev-container config (image + post-create hook)
```

There is **no build step**. TypeScript is executed directly by Node.js using `--experimental-strip-types`.

---

## Key source file: `extensions/index.ts`

Everything lives here. The default export is a function that receives a `pi: ExtensionAPI` object and:

1. **Registers a `/ralph` command** via `pi.registerCommand("ralph", { ... })`.
2. **Listens for `agent_end` events** via `pi.on("agent_end", ...)` to know when each iteration's agent run finishes and to capture the last assistant message.

### Command flow

1. Parse arguments → `{ iterations, promptPath }` (defaults: 3 iterations, max 1000).
2. Validate the prompt path against an allowlist of roots: `cwd`, `~/.pi`, `~/.local`.
3. Read the prompt file from disk.
4. Call `ctx.waitForIdle()` to ensure the agent is ready.
5. Save a reference to the original session (`ctx.sessionManager.getSessionFile()`).
6. For each iteration:
   - Create a new session branched from the original (`ctx.newSession({ parentSession })`).
   - Set `ralphAgentDoneResolve` (the resolver for the per-iteration `Promise`) **before** sending the message.
   - Send the prompt text via `pi.sendUserMessage(trimmedPrompt)` (fire-and-forget — do **not** `await`).
   - Wait for `agent_end` to fire (it resolves the promise and delivers the last assistant message).
   - Write `.ralph/RALPH.md` (always-current summary) and `.ralph/<YYYY>/<MM>/<DD>/RALPH-HH-MM-SS-mmm.md` (per-invocation log + `.jsonl` transcript).

### Coordination pattern

`ralphAgentDoneResolve` is a module-level variable (a `Promise` resolver). The `agent_end` listener
reads it, clears it, and calls it with the result. It must be set **before** `pi.sendUserMessage` is
called to avoid a race where `agent_end` fires before the promise is created.

### Output files (written under `<cwd>/.ralph/`)

| Path | Purpose |
|---|---|
| `.ralph/RALPH.md` | Always-current summary — overwritten on every iteration |
| `.ralph/<YYYY>/<MM>/<DD>/RALPH-<HH>-<MM>-<SS>-<mmm>.md` | Per-invocation snapshot (timestamp fixed at `/ralph` invocation time) |
| `.ralph/<YYYY>/<MM>/<DD>/RALPH-<HH>-<MM>-<SS>-<mmm>.jsonl` | Full session transcript (one JSON message per line), overwritten each iteration |

---

## Running tests

```bash
npm test                # standard output
npm run test:verbose    # spec reporter (verbose)
```

Tests use Node's built-in test runner (`node:test`) with `--experimental-strip-types`.
**No real LLM API key is needed** — a faux provider from `@mariozechner/pi-ai` is used.

### Test design notes

- A `DefaultResourceLoader` is shared across all sessions created during one test so the extension's `pi` API is correctly re-bound after `newSession()` calls.
- `commandContextActions.newSession` mirrors what pi's interactive and print modes do: call `runtime.newSession()` then rebind the session.
- Notifications are captured via a mock `ExtensionUIContext` (`makeMockUIContext`).
- The faux provider responses are queued with `fauxProvider.setResponses([...])` before running a command. Queue exactly one response per expected iteration.

---

## Making changes

### Changing command behaviour

Edit `extensions/index.ts`. The file is self-contained — no other source files exist.

### Adding a new helper function

Add it inside `extensions/index.ts` (module scope, before the `export default` function).

### Changing output file format

Update `buildRalphContent` (the `.md` body) or `writeRalphStateFile` (file layout / JSONL logic).

### Changing path-resolution rules

Update `canReadPath`, `normalizeFsPath`, and/or `isWithinPath`.

---

## Invariants to preserve

- `pi.sendUserMessage` must **not** be awaited — it returns `void` and fires-and-forgets.
- `ralphAgentDoneResolve` must be set **before** `pi.sendUserMessage` is called.
- Every iteration must branch from the **original** session, not from the session created by the previous iteration. The `originalSession` variable is captured once before the loop.
- Path traversal outside the allowed roots must be rejected before any file I/O.
- Backtick fences inside assistant messages must be escaped (`escapeCodeFence`) before writing to `.md` files.

---

## Dependencies

| Package | Role |
|---|---|
| `@mariozechner/pi-coding-agent` | Peer dependency — provides `ExtensionAPI`, session management, agent runtime |
| `@mariozechner/pi-ai` | Dev dependency — provides `registerFauxProvider` / `fauxAssistantMessage` for tests |

Both are declared as `devDependencies` so `npm install` in the repo installs them locally.

---

## Dev container

The repo ships a `.devcontainer/` config using the `ghcr.io/rahulmutt/dev` image. A `post-create.sh` script runs after container creation. When working inside the container, dependencies should already be installed; re-run `npm install` if `node_modules` is missing.
