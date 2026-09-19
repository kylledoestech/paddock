// Write-side operations the PWA can trigger. Each maps onto herdr socket methods of one
// machine (`sock` is that machine's herdr socket, local or forwarded).
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import type { MachineFs } from './fsops.ts'
import { rpc } from './herdr.ts'
import { HttpError } from './http.ts'

// Agent kinds herdr 0.9.1 can start (`herdr agent` lists them).
export const AGENT_KINDS = new Set([
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode',
  'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli',
  'qwen', 'letta', 'maki', 'muse',
])

// Keys the key bar may send; anything else is rejected before reaching herdr.
const ALLOWED_KEYS = new Set(['esc', 'tab', 'up', 'down', 'left', 'right', 'enter', 'ctrl+c', 'shift+tab'])

interface PaneRef {
  pane_id: string
}

/** herdr agent names: `[a-z][a-z0-9_-]{0,31}`, unique among live agents. */
const agentName = (kind: string) => `${kind}-${randomBytes(2).toString('hex')}`

export function assertKind(kind: unknown): string {
  if (typeof kind !== 'string' || !AGENT_KINDS.has(kind)) throw new Error(`unknown agent kind: ${String(kind)}`)
  return kind
}

export async function sendKeys(sock: string, paneId: string, keys: unknown): Promise<void> {
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string' && ALLOWED_KEYS.has(k))) {
    throw new Error('keys must be a non-empty list of allowed keys')
  }
  await rpc(sock, 'pane.send_keys', { pane_id: paneId, keys })
}

async function startAgent(sock: string, paneId: string, kind: string, prompt: string): Promise<void> {
  // agent.start returns once herdr sees the agent ready for input (default 30s startup).
  await rpc(sock, 'agent.start', { name: agentName(kind), kind, pane_id: paneId }, 60_000)
  if (prompt) await rpc(sock, 'agent.prompt', { target: paneId, text: prompt }, 30_000)
}

/** New tab in the workspace, then an agent in its root pane. */
export async function newAgent(sock: string, workspaceId: string, kind: string, prompt: string): Promise<void> {
  const created = await rpc<{ root_pane: PaneRef }>(sock, 'tab.create', { workspace_id: workspaceId, label: kind })
  await startAgent(sock, created.root_pane.pane_id, kind, prompt)
}

/** New tab with a plain shell (no agent) in the workspace; resolves to its pane id. */
export async function newTerminal(sock: string, workspaceId: string, label: string | null): Promise<string> {
  const created = await rpc<{ root_pane: PaneRef }>(sock, 'tab.create', { workspace_id: workspaceId, label, focus: false })
  return created.root_pane.pane_id
}

/** An existing folder for a new space: absolute or `~/…`. */
export async function cleanFolder(fs: MachineFs, raw: unknown): Promise<string> {
  const input = typeof raw === 'string' ? raw.trim() : ''
  const expanded = input === '~' ? fs.home : input.startsWith('~/') ? posix.join(fs.home, input.slice(2)) : input
  if (!expanded || !posix.isAbsolute(expanded)) throw new HttpError(400, 'folder must be an absolute path or start with ~/')
  const folder = posix.normalize(expanded)
  if (!(await fs.stat(folder))?.isDir) throw new HttpError(400, `folder not found: ${input}`)
  return folder
}

/** New herdr workspace (space) in `cwd`, optionally with an agent in its first pane. */
export async function newWorkspace(sock: string, cwd: string, label: string | null, kind: string | null): Promise<void> {
  const created = await rpc<{ root_pane: PaneRef }>(sock, 'workspace.create', { cwd, label, focus: false })
  if (kind) await startAgent(sock, created.root_pane.pane_id, kind, '')
}

/** Git worktree as a new herdr workspace, then an agent in its root pane. */
export async function newWorktree(sock: string, workspaceId: string, branch: string, kind: string): Promise<void> {
  const created = await rpc<{ root_pane: PaneRef }>(sock, 'worktree.create', { workspace_id: workspaceId, branch }, 60_000)
  await startAgent(sock, created.root_pane.pane_id, kind, '')
}

const LABEL_MAX = 60

/** A space or tab name: trimmed, no control characters, 1–60 characters. */
export function cleanLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!label) throw new HttpError(400, 'name can’t be empty')
  if ([...label].length > LABEL_MAX) throw new HttpError(400, `name must be at most ${LABEL_MAX} characters`)
  return label
}

export async function renameWorkspace(sock: string, workspaceId: string, label: string): Promise<void> {
  await rpc(sock, 'workspace.rename', { workspace_id: workspaceId, label })
}

export async function renameTab(sock: string, tabId: string, label: string): Promise<void> {
  await rpc(sock, 'tab.rename', { tab_id: tabId, label })
}

// Closing ends whatever runs there (agents included); the phone confirms first.
export async function closePane(sock: string, paneId: string): Promise<void> {
  await rpc(sock, 'pane.close', { pane_id: paneId })
}

export async function closeTab(sock: string, tabId: string): Promise<void> {
  await rpc(sock, 'tab.close', { tab_id: tabId })
}

export async function closeWorkspace(sock: string, workspaceId: string): Promise<void> {
  await rpc(sock, 'workspace.close', { workspace_id: workspaceId })
}
