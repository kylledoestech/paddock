// Small HTTP helpers shared by the bridge's routes.
import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * The host the browser addressed. Behind `tailscale serve` (a loopback proxy) that is the
 * forwarded host; direct requests use Host. Forwarded headers are only trusted from loopback.
 */
function requestHost(req: IncomingMessage): string | undefined {
  const fromLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
  const forwarded = req.headers['x-forwarded-host']
  if (fromLoopback && typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return req.headers.host
}

/** Browsers always send Origin on cross-site POST and WebSocket; it must match the addressed host. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const host = requestHost(req)
  if (!host) return false
  try {
    const from = new URL(origin)
    // `tailscale serve --https=8443` forwards the host without its port, so compare hostnames
    // when the addressed host carries no port of its own.
    return from.host === host || (!host.includes(':') && from.hostname === host)
  } catch {
    return false
  }
}

export async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBinaryBody(req, 64 * 1024)).toString('utf8')
  const parsed: unknown = JSON.parse(raw || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'body must be a JSON object')
  return parsed as Record<string, unknown>
}
