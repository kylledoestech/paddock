# Chat mode — research and design (Option A: herdr + Claude session)

Goal: show an interactive `claude` session that runs in a herdr pane as a chat on the phone, reliably, without
giving up the terminal or the desktop view. Research date: 2026-09-18. Claude Code 2.1.277, herdr 0.9.1.

## Findings

### Claude Code hooks (verified in https://code.claude.com/docs/en/hooks.md)
- Every hook payload carries `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.
- Hook types include `command` and **`http`** (POSTs the event JSON to a URL; the response body uses the same JSON
  output format). Header values can interpolate env vars listed in `allowedEnvVars`, so
  `X-Herdr-Pane: $HERDR_PANE_ID` works. Default timeout 600s (30s on `UserPromptSubmit`).
- Hooks inherit the pane's environment, so `HERDR_PANE_ID` / `HERDR_SOCKET_PATH` are visible.
- **`PermissionRequest`** fires the moment Claude is about to ask for permission. Input: `tool_name`,
  `tool_input`, `permission_suggestions`. Output `decision.behavior: "allow" | "deny"`, optional `updatedInput`,
  `updatedPermissions` (e.g. "always allow" rules), `message`, `interrupt`. The `permission_prompt` Notification
  only fires after ~6s of waiting.
- **`AskUserQuestion`** is a tool whose `tool_input.questions` holds the question text, header, options and
  `multiSelect`. A `PreToolUse` hook can answer it: `permissionDecision: "allow"` plus `updatedInput` echoing
  `questions` and adding `answers: {"<question>": "<label>"}`.
- **`ExitPlanMode`** (plan approval): hooks receive the injected `plan` markdown and `planFilePath`.
- Other useful events: `SessionStart` (matchers startup/resume/clear/compact/fork), `UserPromptSubmit`, `Stop`,
  `StopFailure`, `Notification` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`, …),
  `SubagentStart/Stop`, `PreCompact/PostCompact`, `SessionEnd`.
- Plugins can ship hooks (`hooks/hooks.json`), so Paddock can install as a Claude Code plugin instead of editing
  the user's settings.json.

### Transcript (`~/.claude/projects/<dir>/<session>.jsonl`)
- Written **per content block**, not per full reply: one assistant message is split across lines (thinking,
  text, each tool_use) sharing `message.id`. In this session 96 of 119 assistant messages were split. So a tailer
  sees each step as it lands.
- Format is internal and versioned (not a stable schema). Parse defensively; skip unparseable trailing lines.
- Record types seen: user/assistant (text, thinking, tool_use, tool_result), attachment, mode, permission-mode,
  ai-title, last-prompt, file-history-delta, bridge-session, …

### herdr
- `herdr integration install claude` adds only a `SessionStart` hook that calls `pane.report_agent_session`
  with the session id. herdr keeps the id (exposed as `agent_session` on pane/agent get/list) but **drops the
  transcript path** for Claude. State still comes from screen rules (`src/detect/manifests/claude.toml`).
- herdr never exposes prompt text or options; only `agent.explain` (which rule matched) and
  `pane.read source=detection` (raw bottom of screen).
- `agent.prompt` honours bracketed paste and refuses to type into a blocked agent (`agent_blocked`).

### collie (prior art) — what it had to work around
- Maps pane → transcript by scanning every project dir for `<session-id>.jsonl`; follows resume/fork rotations
  by "conversation root" heuristics; checks `agent_session.agent == pane.agent` for stale refs.
- Parses prompts from **screen text** (footer grammar: "enter to select", "tab to amend", plan dialog…), with
  re-read guards before sending keys. Verifies sends by polling the screen until the typed text appears.
- Reads history on demand (no tail/watch), 32 MB cap.
- All of these are fragile because they infer from the screen. Hooks remove most of them.

## Design: make Option A exact instead of inferred

| Need | Fragile way (collie) | Paddock way |
|---|---|---|
| Which transcript belongs to a pane | scan dirs by session id, guess rotations | `SessionStart` command hook (http not supported there) sends `session_id` + `transcript_path` + `X-Herdr-Pane` straight to the bridge. Fires again on resume/clear/compact/fork, so rotations are exact |
| Chat content | read whole file on demand | tail the exact file by byte offset + `fs.watch`; push new blocks over the socket |
| Working / blocked / done | screen rules only | herdr state (kept) + hook signals: `UserPromptSubmit`→working, `Stop`→done, `PermissionRequest`/`Notification`→blocked |
| Permission prompt contents | parse footer text | `PermissionRequest` payload: exact tool + input (command, file, diff) |
| Answering permission | send digit keys, re-verify screen | `PermissionRequest` hook returns `allow` / `deny` (+ "always allow" via `updatedPermissions`); desk dialog stays usable meanwhile (tested) |
| AskUserQuestion | parse numbered menu | `PermissionRequest` payload has the questions/options; answer with `allow` + `updatedInput.answers` (tested) |
| Plan approval | parse plan dialog | `ExitPlanMode` payload has the plan markdown; answer with `allow` + `updatedInput` echoing the input (tested) |
| Sending a message | type, poll screen, then Enter | `agent.prompt` (bracketed paste, refuses when blocked); confirm by the `UserPromptSubmit` hook / new user row in the transcript |

Screen parsing stays only as a fallback (unknown dialogs, `/model`-style menus) plus the terminal toggle.

### Performance
- Bridge keeps a per-session cursor; phone gets only deltas (new blocks, tool results) over the existing socket.
- Phone loads the last ~50 turns first, pages older on scroll; virtualized list; tool calls collapsed by default.
- No polling of `pane.read` for chat; herdr events + hooks drive everything.

### Install shape
A Claude Code plugin "paddock" shipping `hooks/hooks.json` with `http` hooks to `http://127.0.0.1:4280/hooks/...`
and header `X-Herdr-Pane: $HERDR_PANE_ID` (`allowedEnvVars: ["HERDR_PANE_ID"]`). Hooks outside herdr (no pane id)
are ignored by the bridge. Coexists with the user's existing PreToolUse/Stop hooks and herdr's SessionStart hook.

## Experiment results (2026-09-18, Claude Code 2.1.277, interactive session in a herdr pane)

Setup: scratch `claude --model haiku --settings <file>` in a throwaway herdr tab, `http` hooks to a local sink
that logged every event and replied after a configurable delay. Scripts kept in the session scratchpad.

| # | Test | Result |
|---|---|---|
| 1 | `PermissionRequest` hook waits 20s, returns nothing | **Terminal dialog appears immediately** while the hook waits. Empty reply leaves the dialog up. The desk is never blocked |
| 2 | Hook returns `allow` 8s later while dialog is showing | Dialog closes, tool runs (file created) |
| 3 | User answers in the terminal first, hook returns `deny` 15s later | Terminal answer wins; late hook reply ignored harmlessly |
| 4 | `PreToolUse` answers `AskUserQuestion` with `updatedInput.answers` | Works in interactive mode ("User answered Claude's questions: → Blue") |
| 5 | `PreToolUse` waiting on `AskUserQuestion` | **Blocks the desk** ("running PreToolUse hook"), question not shown. Don't wait in PreToolUse |
| 6 | `AskUserQuestion` also fires `PermissionRequest`; hook answers 8s later with `allow` + `updatedInput.answers` | Question menu shown at the desk meanwhile; phone answer ("Coffee") resolves it. **One non-blocking path for permissions and questions** |
| 7 | `ExitPlanMode` via `PermissionRequest`, plain `allow` | Not enough: plan dialog stays |
| 7b | `allow` + `updatedInput` echoing the tool input (plan + planFilePath) | Plan approved, Claude executed it; session switched to accept-edits (same as option 1). Use `updatedPermissions` `setMode` to pick a different mode |
| 8 | Hooks pointing at a dead port (bridge down) | Dialog shows normally, answering at the desk works, no error noise, no hang |
| 9 | `MessageDisplay` http hook | 12 batches over ~1.6s for a 12-line reply: **live line-by-line streaming** of assistant text in interactive mode. Reply `{}` fast to leave rendering unchanged (Claude holds each batch until the hook returns) |

Other observations:
- `SessionStart` does **not** support `http` hooks (docs: command and mcp_tool only). Use a `command` hook
  (tiny `curl`) for session → pane mapping.
- `X-Herdr-Pane: $HERDR_PANE_ID` header with `allowedEnvVars` works: every event arrived tagged `pane=w6:p4`.
- `agent.prompt` text arrives in `UserPromptSubmit` wrapped as `<pasted_content id=…>…</pasted_content>`
  (bracketed paste) — strip it when showing the user's message.
- `Notification permission_prompt` fires ~6s after the dialog appears (as documented); `PermissionRequest` is
  the instant signal.
- Sending into a busy screen: `agent.prompt` refuses when blocked, so answers go through hooks, messages
  through `agent.prompt`.

## Resulting design decisions
- **Answers (permission / question / plan): `PermissionRequest` http hook that long-polls the bridge.** The
  desk dialog shows at once; whichever side answers first wins. Hook timeout ~10 min; on timeout or bridge down
  it returns nothing and the desk dialog simply stays.
- **Never wait in `PreToolUse`.** Use it (and `PostToolUse`) only as fast, non-blocking signals.
- **Session mapping: `SessionStart` command hook** posting `session_id`, `transcript_path`, `source`, pane id.
- **Live text: `MessageDisplay` http hook** returning `{}` immediately and forwarding `delta` to the phone;
  transcript tail stays the source of truth (tool calls, results, final text, history).
- **State: `UserPromptSubmit` → working, `PermissionRequest` → blocked (with payload), `Stop`/`StopFailure` →
  done**, herdr screen detection as backup.
- Still to decide: what to show for subagents (`isSidechain`), compaction summaries.
