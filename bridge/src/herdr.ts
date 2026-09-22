// Minimal client for herdr's socket API: newline-delimited JSON over a Unix socket.
// herdr answers one request per connection, so every RPC opens its own connection.
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** This machine's herdr socket. Remote machines are reached through a forwarded copy (machines.ts). */
export const localSocketPath: string =
  process.env.HERDR_SOCKET_PATH ?? join(homedir(), '.config', 'herdr', 'herdr.sock')

export class HerdrError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface Response {
  id: string
  result?: unknown
  error?: { code: string; message: string }
}

/** Splits a socket stream into parsed JSON lines. */
function onLines(sock: Socket, handle: (msg: Response) => void): void {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) handle(JSON.parse(line) as Response)
    }
  })
}

export function rpc<T = unknown>(socketPath: string, method: string, params: object = {}, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `paddock_${randomUUID()}`
    const sock = connect(socketPath)
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new HerdrError('timeout', `${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const finish = (fn: () => void) => {
      clearTimeout(timer)
      sock.destroy()
      fn()
    }
    sock.on('error', (err) => finish(() => reject(new HerdrError('unreachable', err.message))))
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'))
    onLines(sock, (msg) => {
      if (msg.id !== id) return
      if (msg.error) finish(() => reject(new HerdrError(msg.error!.code, msg.error!.message)))
      else finish(() => resolve(msg.result as T))
    })
  })
}

export interface Subscription {
  close: () => void
}

/**
 * Opens a long-lived `events.subscribe` connection. `onReady` fires once herdr
 * acknowledges; `onClose` fires on any disconnect (including a rejected request).
 */
export function subscribe(
  socketPath: string,
  subscriptions: object[],
  handlers: { onReady?: () => void; onEvent: (event: unknown) => void; onClose: (err?: Error) => void },
): Subscription {
  const id = `paddock_sub_${randomUUID()}`
  const sock = connect(socketPath)
  let acked = false
  let closed = false
  const close = (err?: Error) => {
    if (closed) return
    closed = true
    sock.destroy()
    handlers.onClose(err)
  }
  sock.on('connect', () =>
    sock.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n'),
  )
  sock.on('error', (err) => close(err))
  sock.on('close', () => close())
  onLines(sock, (msg) => {
    if (!acked) {
      if (msg.error) return close(new HerdrError(msg.error.code, msg.error.message))
      acked = true
      handlers.onReady?.()
      return
    }
    handlers.onEvent(msg)
  })
  return { close: () => close() }
}
