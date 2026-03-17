# @rahulmutt/pi-ralph

A [pi](https://github.com/badlogic/pi) extension that adds the `/ralph` command — a Ralph Wiggum loop that runs a prompt file repeatedly across fresh sessions.

## Install

```bash
pi install npm:@rahulmutt/pi-ralph
```

Or try it without installing:

```bash
pi -e npm:@rahulmutt/pi-ralph
```

## Usage

```text
/ralph <prompt-file>
/ralph [iterations] <prompt-file>
```

### Examples

```text
/ralph prompts/implement.md
/ralph 5 prompts/implement.md
/ralph 2 "prompts/my prompt.md"
```

### Behavior

- **iterations** is optional and defaults to `3` (max `1000`)
- Each iteration starts in a **fresh session** branched from the original, so context is cleared before the prompt runs
- Progress is persisted to `RALPH.md` in the project root with the current iteration number and last emitted message
- Prompt files may live under the project directory, `~/.pi`, or `~/.local`
- Paths with spaces can be quoted

## How it works

The Ralph Wiggum loop:

1. Waits for the agent to become idle
2. Captures the current session as the parent
3. For each iteration:
   - Creates a new session (branched from the parent)
   - Sends the prompt file contents as a user message
   - Waits for the agent to finish
   - Writes iteration status to `RALPH.md`

This is useful for running the same prompt (e.g., an implementation plan) repeatedly, where each iteration picks up the next uncompleted task from a plan file.

## License

MIT
