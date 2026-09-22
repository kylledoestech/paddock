// Connection to the Paddock bridge (bridge/src/server.ts), same origin as the page.
import type { Snapshot } from '../types/herdr'

export type BridgeState = { online: true; snapshot: Snapshot } | { online: false; error: string }

export interface Notice {
  id: number
  level: 'info' | 'error'
  message: string
}

/** A machine as the bridge reports it. */
export interface MachineInfo {
  id: string
  label: string
  kind: 'local' | 'ssh'
  status: 'online' | 'offline' | 'attention'
  error?: string
}

type BridgeMessage =
  | { type: 'machines'; list: MachineInfo[] }
  | { type: 'state'; machine: MachineInfo; state: BridgeState }
  | { type: 'notice'; level: 'info' | 'error'; message: string }
  | { type: 'pong' }

/** The phone ↔ bridge link, separate from whether herdr itself is reachable. */
export type LinkStatus = 'connecting' | 'open' | 'reconnecting'

export interface LiveHandlers {
  onMachines: (list: MachineInfo[]) => void
  onState: (machine: MachineInfo, state: BridgeState) => void
  onNotice: (level: 'info' | 'error', message: string) => void
  onLink: (status: LinkStatus) => void
}

/** Media whose extension the browser can play as video; everything else is treated as an image. */
export const isVideoPath = (path: string): boolean => /\.(mp4|m4v|mov|webm)$/i.test(path)

export const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`

const HEARTBEAT_MS = 20_000
const PONG_TIMEOUT_MS = 4_000
const MAX_RETRY_MS = 8_000

/**
 * Calls `onResume` whenever the page comes back to the foreground. Phones freeze background
 * tabs and silently kill (or half-kill) their sockets, so every live connection re-checks here.
 */
export function onPageResume(onResume: () => void): () => void {
  const onVisible = () => document.visibilityState === 'visible' && onResume()
  const events: [EventTarget, string, () => void][] = [
    [document, 'visibilitychange', onVisible],
    [document, 'resume', onResume], // Chrome's page lifecycle: unfrozen
    [window, 'pageshow', onResume], // restored from back/forward cache
    [window, 'online', onResume], // network came back
  ]
  for (const [target, type, fn] of events) target.addEventListener(type, fn)
  return () => {
    for (const [target, type, fn] of events) target.removeEventListener(type, fn)
  }
}

/**
 * Keeps the state socket alive: reconnects with backoff, pings to catch sockets the phone left
 * half-open, and reconnects at once when the page returns to the foreground. Returns a stop function.
 */
export function connectLive(handlers: LiveHandlers): () => void {
  let ws: WebSocket | null = null
  let stopped = false
  let delay = 500
  let retryTimer: number | undefined
  let pongTimer: number | undefined
  let heartbeat: number | undefined

  const clearTimers = () => {
    window.clearTimeout(retryTimer)
    window.clearTimeout(pongTimer)
    window.clearInterval(heartbeat)
  }

  /** Detaches the current socket so its late events can't schedule anything. */
  const drop = () => {
    if (!ws) return
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    ws.close()
    ws = null
  }

  const reconnectSoon = () => {
    clearTimers()
    drop()
    if (stopped) return
    handlers.onLink('reconnecting')
    retryTimer = window.setTimeout(open, delay)
    delay = Math.min(delay * 2, MAX_RETRY_MS)
  }

  const reconnectNow = () => {
    delay = 500
    clearTimers()
    drop()
    if (!stopped) open()
  }

  /** Sends a ping; no reply in time means the socket is dead even if it claims to be open. */
  const probe = () => {
    if (ws?.readyState !== WebSocket.OPEN) return reconnectNow()
    window.clearTimeout(pongTimer)
    pongTimer = window.setTimeout(reconnectNow, PONG_TIMEOUT_MS)
    ws.send(JSON.stringify({ type: 'ping' }))
  }

  function open() {
    const socket = new WebSocket(wsUrl('/ws'))
    ws = socket
    socket.onopen = () => {
      delay = 500
      handlers.onLink('open')
      heartbeat = window.setInterval(() => document.visibilityState === 'visible' && probe(), HEARTBEAT_MS)
    }
    socket.onmessage = (e) => {
      // Any message proves the link is alive.
      window.clearTimeout(pongTimer)
      const msg = JSON.parse(e.data as string) as BridgeMessage
      if (msg.type === 'machines') handlers.onMachines(msg.list)
      else if (msg.type === 'state') handlers.onState(msg.machine, msg.state)
      else if (msg.type === 'notice') handlers.onNotice(msg.level, msg.message)
    }
    socket.onclose = reconnectSoon
    socket.onerror = reconnectSoon
  }

  handlers.onLink('connecting')
  open()
  // Back from another app: verify the socket (or replace a stuck attempt) right away.
  const stopResume = onPageResume(() => (ws?.readyState === WebSocket.OPEN ? probe() : reconnectNow()))

  return () => {
    stopped = true
    clearTimers()
    stopResume()
    drop()
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

const post = (path: string, body: unknown) =>
  request<unknown>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export type ClaudeMode = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypass'

export interface MediaItem {
  name: string
  /** File path on the machine; empty for images embedded in the session log. */
  path: string
  mtime: number
  url: string
}

export interface PaneMedia {
  session: MediaItem[]
  project: MediaItem[]
  uploads: MediaItem[]
}

/** Base of one machine's routes on the bridge. */
const machineBase = (machineId: string) => `/api/m/${encodeURIComponent(machineId)}`
const enc = encodeURIComponent

/** URL of an image file a pane printed; the bridge validates the path. */
export const imageUrl = (machineId: string, paneId: string, path: string) =>
  `${machineBase(machineId)}/panes/${enc(paneId)}/image?path=${enc(path)}`

/** Every action, bound to one machine. */
export function apiFor(machineId: string) {
  const base = machineBase(machineId)
  const pane = (paneId: string, rest: string) => `${base}/panes/${enc(paneId)}/${rest}`
  return {
    sendKeys: (paneId: string, keys: string[]) => post(pane(paneId, 'keys'), { keys }),
    media: (paneId: string) => request<PaneMedia>(pane(paneId, 'media')),
    /** Claude's permission mode, read from its status line (null when not visible). */
    getMode: async (paneId: string) => (await request<{ mode: ClaudeMode | null }>(pane(paneId, 'mode'))).mode,
    /** Presses Shift+Tab until Claude shows `mode`; resolves to the mode reached. */
    setMode: async (paneId: string, mode: ClaudeMode) =>
      (await request<{ mode: ClaudeMode }>(pane(paneId, 'mode'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })).mode,
    /** Saves an image into the pane's project (`.paddock/uploads/`); resolves to its absolute path. */
    uploadImage: async (paneId: string, image: Blob) =>
      (await request<{ path: string }>(pane(paneId, 'uploads'), {
        method: 'POST',
        headers: { 'content-type': image.type },
        body: image,
      })).path,
    renameWorkspace: (workspaceId: string, label: string) => post(`${base}/workspaces/${enc(workspaceId)}/rename`, { label }),
    renameTab: (tabId: string, label: string) => post(`${base}/tabs/${enc(tabId)}/rename`, { label }),
    closeWorkspace: (workspaceId: string) => post(`${base}/workspaces/${enc(workspaceId)}/close`, {}),
    closeTab: (tabId: string) => post(`${base}/tabs/${enc(tabId)}/close`, {}),
    closePane: (paneId: string) => post(pane(paneId, 'close'), {}),
    /** Opens a plain shell in a new tab; resolves to its pane id once the bridge can see it. */
    newTerminal: async (workspaceId: string, label: string) =>
      (await request<{ pane_id: string }>(`${base}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, label }),
      })).pane_id,
    newWorkspace: (cwd: string, label: string, kind: string | null) => post(`${base}/workspaces`, { cwd, label, kind }),
    newAgent: (workspaceId: string, kind: string, prompt: string) => post(`${base}/agents`, { workspace_id: workspaceId, kind, prompt }),
    newWorktree: (workspaceId: string, branch: string, kind: string) =>
      post(`${base}/worktrees`, { workspace_id: workspaceId, branch, kind }),
  }
}

export type MachineApi = ReturnType<typeof apiFor>
