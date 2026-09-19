// Live, writable pane session via `herdr terminal session control`.
//
// The phone takes control of the pane at its own size, so text stays readable and typing
// works; while it holds control the desktop view of that pane reflows to the phone size.
// Leaving sends `terminal.release`, which hands the size back.
//
// stdout: newline-delimited JSON `terminal.frame` ({seq, bytes(base64 ansi), full, width, height})
//         and `terminal.closed`, forwarded to the browser unchanged.
// stdin:  `terminal.input` / `terminal.resize` / `terminal.scroll` / `terminal.release`.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import type { Machine } from './machines.ts'

// Absolute path: the bridge may run under systemd without the user's PATH.
export const herdrBin: string =
  process.env.HERDR_BIN ??
  [join(homedir(), '.local', 'bin', 'herdr'), '/usr/local/bin/herdr', '/usr/bin/herdr'].find(existsSync) ??
  'herdr'

// Panes a phone is looking at right now (open control sessions; phones drop theirs when backgrounded).
const viewing = new Map<string, number>()
const viewKey = (machineId: string, paneId: string) => `${machineId}/${paneId}`
export const isViewing = (machineId: string, paneId: string) => (viewing.get(viewKey(machineId, paneId)) ?? 0) > 0

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(n)))
export const clampCols = (n: number) => clamp(n, 20, 400)
export const clampRows = (n: number) => clamp(n, 5, 200)

/** Messages the browser may send. Anything else is dropped. */
type BrowserMessage =
  | { type: 'input'; text: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'scroll'; direction: 'up' | 'down'; lines: number }

function toCommand(raw: string): object | null {
  let msg: BrowserMessage
  try {
    msg = JSON.parse(raw) as BrowserMessage
  } catch {
    return null
  }
  switch (msg?.type) {
    case 'input':
      return typeof msg.text === 'string' && msg.text.length > 0 && msg.text.length <= 16_384
        ? { type: 'terminal.input', text: msg.text }
        : null
    case 'resize':
      return Number.isFinite(msg.cols) && Number.isFinite(msg.rows)
        ? { type: 'terminal.resize', cols: clampCols(msg.cols), rows: clampRows(msg.rows) }
        : null
    case 'scroll':
      return (msg.direction === 'up' || msg.direction === 'down') && Number.isFinite(msg.lines)
        ? { type: 'terminal.scroll', direction: msg.direction, lines: clamp(msg.lines, 1, 50) }
        : null
    default:
      return null
  }
}

export function controlPane(ws: WebSocket, machine: Machine, paneId: string, cols: number, rows: number): void {
  // --takeover: the most recently opened phone view wins over an older one.
  // On a remote machine this runs over its SSH connection with the same stdin/stdout protocol.
  const child = machine.spawnHerdr([
    'terminal', 'session', 'control', paneId, '--takeover', '--cols', String(clampCols(cols)), '--rows', String(clampRows(rows)),
  ])

  const key = viewKey(machine.id, paneId)
  viewing.set(key, (viewing.get(key) ?? 0) + 1)
  const write = (command: object) => {
    if (child.stdin?.writable) child.stdin!.write(JSON.stringify(command) + '\n')
  }

  let buf = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line && ws.readyState === ws.OPEN) ws.send(line)
    }
  })

  let stderr = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-500)
  })

  const closeSocket = (code: number | null, message: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'terminal.closed', code, message }))
      ws.close()
    }
  }
  child.on('exit', (code) => closeSocket(code, stderr.trim()))
  child.on('error', (err) => closeSocket(null, err.message))

  ws.on('message', (data) => {
    const command = toCommand(data.toString())
    if (command) write(command)
  })

  ws.on('close', () => {
    const left = (viewing.get(key) ?? 1) - 1
    if (left > 0) viewing.set(key, left)
    else viewing.delete(key)
    // Hand control (and the pane size) back, then make sure the helper exits.
    write({ type: 'terminal.release' })
    child.stdin?.end()
    setTimeout(() => child.kill('SIGTERM'), 1000).unref()
  })
}
