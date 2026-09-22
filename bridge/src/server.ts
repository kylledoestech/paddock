// Paddock bridge: serves the PWA and relays herdr state, pane output and actions for every machine
// (this one plus herdr's saved SSH machines, see machines.ts).
//
// Security: this process can type into every terminal herdr runs, so it listens on loopback
// only; phones reach it over HTTPS through `tailscale serve` (tailnet only). PADDOCK_HOSTS can add
// addresses. Cross-origin browser requests are rejected. Device pairing comes later.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  assertKind,
  cleanFolder,
  cleanLabel,
  closePane,
  closeTab,
  closeWorkspace,
  newAgent,
  newTerminal,
  newWorkspace,
  newWorktree,
  renameTab,
  renameWorkspace,
  sendKeys,
} from './actions.ts'
import { controlPane } from './terminal.ts'
import { json, readBinaryBody, readJsonBody, sameOrigin } from './http.ts'
import { handleMedia, type MediaPane } from './media.ts'
import { MachineRegistry, type Machine } from './machines.ts'
import { initPush, sendPush, subscribe, unsubscribe, vapidPublicKey } from './push.ts'
import { startNotifier } from './notifier.ts'
import { staticHandler } from './static.ts'
import { currentMode, MODES, switchMode, type ClaudeMode } from './mode.ts'
import { MAX_AUDIO_BYTES, transcribe, transcriptionConfigured } from './transcribe.ts'

const PORT = Number(process.env.PADDOCK_PORT ?? 4280)
const WEB_ROOT = resolve(fileURLToPath(new URL('../../web/dist', import.meta.url)))

const listenHosts = (): string[] =>
  process.env.PADDOCK_HOSTS ? process.env.PADDOCK_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) : ['127.0.0.1']

// ---------- machines and state ----------

const registry = new MachineRegistry()
const stateClients = new Set<WebSocket>()

const stateMessage = (m: Machine) => JSON.stringify({ type: 'state', machine: m.info(), state: m.hub.state })
const machinesMessage = () => JSON.stringify({ type: 'machines', list: registry.list().map((m) => m.info()) })

function broadcast(message: string): void {
  for (const ws of stateClients) if (ws.readyState === ws.OPEN) ws.send(message)
}

const notice = (level: 'info' | 'error', message: string) => broadcast(JSON.stringify({ type: 'notice', level, message }))

/** Per-machine wiring: state broadcasts and notifications, undone when the machine goes away. */
const wired = new Map<Machine, () => void>()
function syncWiring(): void {
  const current = new Set(registry.list())
  for (const [machine, unwire] of wired) {
    if (!current.has(machine)) {
      unwire()
      wired.delete(machine)
    }
  }
  for (const machine of current) {
    if (wired.has(machine)) continue
    const send = () => broadcast(stateMessage(machine))
    const offs = [
      machine.hub.onChange(send),
      machine.onStatus(send),
      startNotifier(machine, () => registry.list().length > 1),
    ]
    wired.set(machine, () => offs.forEach((off) => off()))
  }
  broadcast(machinesMessage())
}
registry.onChange(syncWiring)

// ---------- per-machine helpers ----------

const snapshotOf = (m: Machine) => (m.hub.state.online ? m.hub.state.snapshot : null)

function findPane(m: Machine, paneId: string): MediaPane | undefined {
  return (snapshotOf(m)?.panes as MediaPane[] | undefined)?.find((p) => p.pane_id === paneId)
}

function workspaceExists(m: Machine, workspaceId: unknown): workspaceId is string {
  const workspaces = (snapshotOf(m)?.workspaces ?? []) as { workspace_id: string }[]
  return typeof workspaceId === 'string' && workspaces.some((w) => w.workspace_id === workspaceId)
}

function tabExists(m: Machine, tabId: string): boolean {
  const tabs = (snapshotOf(m)?.tabs ?? []) as { tab_id: string }[]
  return tabs.some((t) => t.tab_id === tabId)
}

/** Resolves once the machine's snapshot contains `paneId` (or after `timeoutMs`), so the phone can open it at once. */
function waitForPane(m: Machine, paneId: string, timeoutMs = 3000): Promise<void> {
  if (findPane(m, paneId)) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      stop()
      resolve()
    }
    const stop = m.hub.onChange(() => findPane(m, paneId) && done())
    const timer = setTimeout(done, timeoutMs)
    m.hub.invalidate()
  })
}

/** Runs a slow herdr action after replying 202; the outcome reaches clients as a notice. */
function runInBackground(label: string, task: () => Promise<void>): void {
  task().then(
    () => notice('info', `${label} ready`),
    (err: Error) => notice('error', `${label} failed: ${err.message}`),
  )
}

// ---------- HTTP ----------

const serveStatic = staticHandler(WEB_ROOT)

/** Routes under /api/m/:machine — everything that acts on one machine's herdr. */
async function handleMachineApi(req: IncomingMessage, res: ServerResponse, m: Machine, rest: string, url: URL): Promise<void> {
  if (await handleMedia(req, res, rest, url, m, (id) => findPane(m, id))) return

  // Claude permission mode: GET reads it from the screen, POST switches to {mode}.
  const modeMatch = rest.match(/^\/panes\/([^/]+)\/mode$/)
  if (modeMatch) {
    const paneId = decodeURIComponent(modeMatch[1])
    const pane = findPane(m, paneId)
    if (!pane) return json(res, 404, { error: 'pane not found' })
    if (pane.agent !== 'claude') return json(res, 400, { error: 'modes are a Claude feature' })
    if (req.method === 'GET') return json(res, 200, { mode: await currentMode(m.socketPath, paneId) })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' })
    const target = (await readJsonBody(req)).mode
    if (typeof target !== 'string' || !MODES.has(target as ClaudeMode)) return json(res, 400, { error: 'unknown mode' })
    return json(res, 200, { mode: await switchMode(m.socketPath, paneId, target as ClaudeMode) })
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' })
  if (!snapshotOf(m)) return json(res, 503, { error: `${m.label} is offline` })

  const sock = m.socketPath
  const body = await readJsonBody(req)

  const closeMatch = rest.match(/^\/(workspaces|tabs|panes)\/([^/]+)\/close$/)
  if (closeMatch) {
    const id = decodeURIComponent(closeMatch[2])
    const kind = closeMatch[1]
    const exists = kind === 'workspaces' ? workspaceExists(m, id) : kind === 'tabs' ? tabExists(m, id) : !!findPane(m, id)
    if (!exists) return json(res, 404, { error: 'already closed' })
    await (kind === 'workspaces' ? closeWorkspace(sock, id) : kind === 'tabs' ? closeTab(sock, id) : closePane(sock, id))
    m.hub.invalidate()
    return json(res, 200, { ok: true })
  }

  const renameMatch = rest.match(/^\/(workspaces|tabs)\/([^/]+)\/rename$/)
  if (renameMatch) {
    const id = decodeURIComponent(renameMatch[2])
    const isWorkspace = renameMatch[1] === 'workspaces'
    if (isWorkspace ? !workspaceExists(m, id) : !tabExists(m, id)) {
      return json(res, 404, { error: `${isWorkspace ? 'space' : 'tab'} not found` })
    }
    const label = cleanLabel(body.label)
    await (isWorkspace ? renameWorkspace(sock, id, label) : renameTab(sock, id, label))
    return json(res, 200, { ok: true, label })
  }

  const keysMatch = rest.match(/^\/panes\/([^/]+)\/keys$/)
  if (keysMatch) {
    const paneId = decodeURIComponent(keysMatch[1])
    if (!findPane(m, paneId)) return json(res, 404, { error: 'pane not found' })
    await sendKeys(sock, paneId, body.keys)
    return json(res, 200, { ok: true })
  }

  if (rest === '/terminals') {
    if (!workspaceExists(m, body.workspace_id)) return json(res, 404, { error: 'workspace not found' })
    const label = typeof body.label === 'string' && body.label.trim() ? cleanLabel(body.label) : null
    const paneId = await newTerminal(sock, body.workspace_id, label)
    await waitForPane(m, paneId)
    return json(res, 201, { pane_id: paneId })
  }

  if (rest === '/workspaces') {
    const cwd = await cleanFolder(m.fs, body.cwd)
    const label = typeof body.label === 'string' && body.label.trim() ? cleanLabel(body.label) : null
    const kind = body.kind ? assertKind(body.kind) : null
    const name = label ?? cwd.split('/').pop() ?? cwd
    runInBackground(kind ? `space ${name} with ${kind}` : `space ${name}`, () => newWorkspace(sock, cwd, label, kind))
    return json(res, 202, { ok: true })
  }

  if (rest === '/agents') {
    if (!workspaceExists(m, body.workspace_id)) return json(res, 404, { error: 'workspace not found' })
    const kind = assertKind(body.kind)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 8000) : ''
    const workspaceId = body.workspace_id
    runInBackground(`${kind} agent`, () => newAgent(sock, workspaceId, kind, prompt))
    return json(res, 202, { ok: true })
  }

  if (rest === '/worktrees') {
    if (!workspaceExists(m, body.workspace_id)) return json(res, 404, { error: 'workspace not found' })
    const kind = assertKind(body.kind)
    const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    if (!/^[\w./-]{1,100}$/.test(branch) || branch.startsWith('-')) return json(res, 400, { error: 'invalid branch name' })
    const workspaceId = body.workspace_id
    runInBackground(`worktree ${branch}`, () => newWorktree(sock, workspaceId, branch, kind))
    return json(res, 202, { ok: true })
  }

  json(res, 404, { error: 'not found' })
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname
  const machineMatch = path.match(/^\/api\/m\/([^/]+)(\/.*)$/)
  if (machineMatch) {
    const machine = registry.get(decodeURIComponent(machineMatch[1]))
    if (!machine) return json(res, 404, { error: 'unknown machine' })
    return handleMachineApi(req, res, machine, machineMatch[2], url)
  }

  if (req.method === 'GET' && path === '/api/machines') return json(res, 200, registry.list().map((m) => m.info()))
  if (req.method === 'GET' && path === '/api/push/key') return json(res, 200, { key: vapidPublicKey() })
  if (req.method === 'GET' && path === '/api/transcribe') return json(res, 200, { configured: await transcriptionConfigured() })
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' })

  // Mic key: raw audio in, text out. Hint and language arrive as query parameters.
  if (path === '/api/transcribe') {
    const audio = await readBinaryBody(req, MAX_AUDIO_BYTES)
    const hint = (url.searchParams.get('hint') ?? '').slice(0, 300)
    const language = url.searchParams.get('lang')?.match(/^[a-z]{2}$/)?.[0] ?? null
    const started = Date.now()
    try {
      const text = await transcribe(audio, req.headers['content-type'], hint, language)
      console.log(`[paddock] voice ${audio.length}B ${req.headers['content-type']} lang=${language ?? 'auto'} ${Date.now() - started}ms ok (${text.length} chars)`)
      return json(res, 200, { text })
    } catch (err) {
      console.log(`[paddock] voice ${audio.length}B ${req.headers['content-type']} lang=${language ?? 'auto'} failed: ${(err as Error).message}`)
      throw err
    }
  }

  const body = await readJsonBody(req)
  if (path === '/api/push/subscribe') {
    await subscribe(body.subscription, body.prefs)
    return json(res, 200, { ok: true })
  }
  if (path === '/api/push/unsubscribe') {
    await unsubscribe(body.endpoint)
    return json(res, 200, { ok: true })
  }
  if (path === '/api/push/test') {
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : undefined
    const delivered = await sendPush(
      { kind: 'test', title: 'Notifications connected', body: 'Paddock will tell you when your agents need you', tag: 'test', url: '/' },
      endpoint,
    )
    return json(res, 200, { delivered })
  }
  json(res, 404, { error: 'not found' })
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://paddock')
  const handler = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res)
  handler.catch((err: Error) => {
    if (!res.headersSent) json(res, (err as { status?: number }).status ?? 400, { error: err.message })
    else res.end()
  })
}

// ---------- WebSocket ----------

// Compress larger messages (state snapshots, full-screen repaints); small keystroke frames go as-is.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } })

// Protocol-level heartbeat: a phone that froze the tab (or lost Wi-Fi) never closes its socket.
// Terminating it releases the pane it controlled, so the desktop gets its size back.
const HEARTBEAT_MS = 15_000
const alive = new WeakMap<WebSocket, boolean>()
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate()
      continue
    }
    alive.set(ws, false)
    ws.ping()
  }
}, HEARTBEAT_MS).unref()

function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://paddock')
  if (!sameOrigin(req) || (url.pathname !== '/ws' && url.pathname !== '/ws/term')) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    if (url.pathname === '/ws') {
      stateClients.add(ws)
      ws.on('close', () => stateClients.delete(ws))
      // App-level ping from the phone after it returns from the background.
      ws.on('message', (data) => {
        if (data.toString() === '{"type":"ping"}') ws.send('{"type":"pong"}')
      })
      ws.send(machinesMessage())
      for (const machine of registry.list()) ws.send(stateMessage(machine))
      return
    }
    const closeWith = (message: string) => {
      ws.send(JSON.stringify({ type: 'terminal.closed', code: null, message }))
      ws.close()
    }
    const machine = registry.get(url.searchParams.get('machine') ?? registry.local.id)
    if (!machine) return closeWith('unknown machine')
    const paneId = url.searchParams.get('pane') ?? ''
    if (!findPane(machine, paneId)) return closeWith('pane not found')
    // The phone's own size in cells; the pane is resized to it while controlled.
    const cols = Number(url.searchParams.get('cols') ?? 80)
    const rows = Number(url.searchParams.get('rows') ?? 24)
    controlPane(ws, machine, paneId, cols, rows)
  })
}

// ---------- start ----------

await initPush()
syncWiring()
await registry.start()
// One listener per address so the LAN interface is never bound.
for (const host of listenHosts()) {
  const server = createServer(handleRequest)
  server.on('upgrade', handleUpgrade)
  server.listen(PORT, host, () => console.log(`[paddock] http://${host}:${PORT}`))
}
