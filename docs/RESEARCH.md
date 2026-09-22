# Paddock — herdr research

Paddock is a PWA for [herdr](https://herdr.dev): drive herdr workspaces, panes, and AI coding agents from a phone.
Research date: 2026-09-18. Installed herdr: **0.9.1**, socket protocol **22**, API schema_version 1.

## What herdr is

- Terminal workspace manager / "tmux rebuilt around coding agents". Rust, single static binary (`~/.local/bin/herdr`).
- GitHub: https://github.com/herdrdev/herdr (YC company, author Can Celik). Docs: https://herdr.dev, https://herdr.dev/llms.txt.
- Model: **workspaces → tabs → panes**. Pane ids like `w1:p1`, tab ids `w1:t1`. Pane ids are *not* stable across a server restart; `terminal_id` is.
- Background server keeps PTYs alive; clients attach/detach (`ctrl+b q`). Named sessions = separate servers.
- Agent detection: each pane gets `agent` (claude, codex, cursor, opencode, …) and `agent_status`: `idle | working | blocked | done | unknown` (`done` = idle and not yet seen).
- Remote: `herdr --remote ssh://host`, saved SSH machines (federation). Has a built-in narrow-terminal "mobile layout" for SSH-from-phone use (`ui.mobile_width_threshold`).
- Plugins: `herdr-plugin.toml` manifest with `[[startup]]`, `[[actions]]`, `[[events]]`, `[[panes]]`, `[[link_handlers]]`. Install: `herdr plugin install owner/repo`. Marketplace = GitHub topic `herdr-plugin`.

## Integration surface

### Raw socket API (primary for Paddock)
- Newline-delimited JSON over Unix socket `~/.config/herdr/herdr.sock` (named session: `~/.config/herdr/sessions/<name>/herdr.sock`; override `HERDR_SOCKET_PATH`).
- Request `{"id":"r1","method":"ping","params":{}}` → `{"id":"r1","result":{...}}` or `{"id":..,"error":{"code","message"}}`.
- Full JSON Schema: `docs/herdr/herdr-api-schema.json` (from `herdr api schema --output`). Method list + semantics: `docs/herdr/socket-api.mdx`.
- Key methods for a PWA:
  - `session.snapshot` — bootstrap (workspaces, tabs, panes, layouts, agents, focus). Sample: `docs/herdr/herdr-snapshot-sample.json`.
  - `events.subscribe` — long-lived stream. 27 event types (workspace.*, tab.*, pane.*, worktree.*, layout.updated).
  - `pane.read` — `source: visible|recent|recent_unwrapped|detection`, `format: text|ansi`, `strip_ansi`, `lines`.
  - `pane.send_text`, `pane.send_keys` (combos: `enter`, `esc`, `ctrl+c`, `shift+tab`, `f1`…), `pane.send_input` (text + keys).
  - `agent.list/get/read/prompt/wait` — `agent.prompt` with `wait: {until:[...], timeout_ms}` avoids races; returns `agent_blocked` if already blocked.
  - `pane.wait_for_output` / `pane.output_matched` (substring/regex) — custom alerts.
  - `workspace.* / tab.* / pane.split|close|zoom|focus|rename`, `worktree.create/open/remove`, `layout.export/apply`.
  - `notification.show`, `pane.report_metadata` (tokens, titles), `agent.view.set` (filter/sort Agents view).
- Verified locally: `pane.read` over raw socket works; `events.subscribe` with `pane.agent_status_changed` but no `pane_id` → `invalid_request: missing field pane_id`.

### Live terminal stream
- No `terminal.*` socket methods in 0.9.1. Live bytes come from the CLI:
  - `herdr terminal session observe <target> [--cols N] [--rows N]` — read-only, NDJSON frames `{seq, bytes(base64), encoding:"ansi", full, width, height}`.
  - `herdr terminal session control …` — exclusive input holder (`CONTROL_HELD`, `--takeover`); **resizes the shared PTY** (fights desktop client).
  - `herdr terminal attach` — direct attach.
- Source: `ref/herdr/src/client/terminal_sessions.rs`, `ref/herdr/src/cli.rs`.

## Gotchas (verified by prior art + local tests)
- One RPC per connection; `id` must be a string; request line cap 1 MiB.
- Subscribe **before** `session.snapshot`, buffer events, then apply (0.9.0+ no event replay).
- `pane.agent_status_changed`, `pane.output_matched`, `pane.scroll_changed` subscriptions need `pane_id` → resubscribe per pane on `pane.created`. Subscribing to all 27 kinds without it fails the whole call.
- `pane.read source=recent` with `lines > viewport_rows` scrolls the operator's real screen. Background polls: use `visible`.
- `send_text` = raw bytes, no bracketed paste; `\n` acts as Enter. Ack ≠ program acted on it — verify by read-back.
- `send_keys` rejects `PageUp/Home/End/Delete`.
- `revision` is always 0; `pane.rename` emits no event.
- herdr sends periodic `full:true` repaints (~3 per 10s idle) — reset xterm only on first full frame after attach/gap, else causes flicker.
- Launch `herdr` by absolute path under systemd/launchd.

## Prior art (cloned in `ref/`, all MIT)
| Project | Stack | herdr link | Live terminal | Push | Auth |
|---|---|---|---|---|---|
| [collie](https://github.com/magoz/collie) | Bun bridge + React 19/Vite/Tailwind/shadcn | raw socket, polling + event pokes | no (ANSI → React text) | Web Push, blocked/done, batched | Tailscale serve + identity header, pairing token for writes |
| [herdr-web](https://github.com/barnuri/herdr-web) | Node + ws + node-pty, React 18 + xterm.js | PTY of whole herdr TUI per tab; CLI poll 2s | yes (full TUI) | Web Push | none (Origin check only) |
| [herdr-expose](https://github.com/muthuishere/herdr-expose) | Go binary + embedded React/xterm.js | socket + `terminal session observe/control` | yes, focused pane only | none | local/lan/cloudflare modes, QR pairing, hashed revocable tokens |

Best ideas: collie's `HERDR_API.md` gotcha list, blocked-prompt → tappable buttons, "Needs you" triage, quick-replies/keys config; expose's observe streaming + flicker fix, subscribe-then-snapshot, host-only QR pairing; herdr-web's quick-key strip, touch gestures, image upload to pane cwd.

Gaps none fill: live terminal **and** push **and** auth together; notification body with the agent's actual question; notification action buttons (approve from lock screen); phone vs desktop PTY size conflict; `pane.output_matched` custom alerts; offline/queued replies.

## Proposed Paddock architecture (draft)
1. Daemon (Bun/TS or Go) shipped as a herdr plugin `[[startup]]`, pidfile lock, absolute `herdr` path.
2. Control: raw socket, one RPC per connection; subscribe → snapshot → apply; resync on reconnect.
3. Live pane: `terminal session observe` default; input via `pane.send_text/send_keys` (no PTY resize). `control` only on explicit take-over.
4. Other panes: `pane.read visible/ansi` summary tiles.
5. Browser: one WebSocket (JSON control + binary frames) → xterm.js with flicker-safe reset.
6. Blocked agents: `pane.read source=detection` → Q&A buttons + notification body.
7. Push: Web Push/VAPID on `blocked` and `working→done`, batched, deep links, action buttons.
8. Auth: loopback bind + Host/Origin gate; `tailscale serve` default; QR pairing, hashed revocable device tokens; service worker never caches API.

## Files
- `docs/herdr/` — herdr 0.9.1 docs (`*.mdx`), API schema, default config, agent skill (`herdr --skill`), sample snapshot.
- `ref/herdr` — herdr source (gitignored). `ref/prior-*` — prior-art repos (gitignored).
