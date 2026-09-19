// Serves the built PWA (web/dist). Text assets are brotli/gzip-compressed once and kept in
// memory, keyed by path + mtime, so repeat requests cost a map lookup. Hashed assets are
// immutable; everything else revalidates.
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from './http.ts'

const brotli = promisify(brotliCompress)
const gz = promisify(gzip)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}
// Already-compressed formats gain nothing from another pass.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg'])

interface Entry {
  mtime: number
  raw: Buffer
  br?: Buffer
  gzip?: Buffer
}
const cache = new Map<string, Entry>()

async function load(file: string, mtime: number): Promise<Entry> {
  const hit = cache.get(file)
  if (hit && hit.mtime === mtime) return hit
  const raw = await readFile(file)
  const entry: Entry = { mtime, raw }
  if (COMPRESSIBLE.has(extname(file)) && raw.length > 1024) {
    ;[entry.br, entry.gzip] = await Promise.all([
      brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
      gz(raw, { level: 9 }),
    ])
  }
  cache.set(file, entry)
  return entry
}

export function staticHandler(webRoot: string) {
  const assetsDir = join(webRoot, 'assets')
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://orca')
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = join(webRoot, rel)
    if (!file.startsWith(webRoot)) return json(res, 403, { error: 'forbidden' })
    let info = await stat(file).catch(() => null)
    if (info?.isDirectory()) {
      file = join(file, 'index.html')
      info = await stat(file).catch(() => null)
    }
    if (!info) {
      file = join(webRoot, 'index.html') // SPA fallback
      info = await stat(file).catch(() => null)
    }
    if (!info) return json(res, 404, { error: 'web build missing: run `npm run build` in web/' })

    const entry = await load(file, info.mtimeMs)
    const accept = String(req.headers['accept-encoding'] ?? '')
    const [body, encoding] =
      entry.br && /\bbr\b/.test(accept) ? [entry.br, 'br'] : entry.gzip && /\bgzip\b/.test(accept) ? [entry.gzip, 'gzip'] : [entry.raw, null]
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': String(body.length),
      'cache-control': file.startsWith(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache',
      vary: 'accept-encoding',
      ...(encoding ? { 'content-encoding': encoding } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}
