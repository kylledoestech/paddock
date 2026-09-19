// Images between phone and panes: uploads into the pane's project, recent project images,
// and validated serving of image files a pane printed or produced. Works on any machine
// through its MachineFs (local disk or SSH).
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import type { MachineFs } from './fsops.ts'
import { HttpError } from './http.ts'

const { basename, extname, isAbsolute, join, relative, resolve } = posix

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const MAX_SERVE_BYTES = 25 * 1024 * 1024
const UPLOAD_DIR = join('.orca', 'uploads')
const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const UPLOAD_MAX_FILES = 50
// Only names this store writes are ever pruned.
const UPLOAD_NAME = /^img-\d{8}T\d{6}-[a-f0-9]{6}\.(png|jpg|webp|gif)$/

const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000
const RECENT_MAX = 60
const WALK_MAX_DEPTH = 6
const WALK_SKIP = ['node_modules', '.git', 'dist', 'build', '.next', 'target', '.cache', '.venv', '__pycache__']

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

const UPLOAD_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface ImageEntry {
  name: string
  path: string
  mtime: number
}

/** Raster formats must start with their signature; SVG must look like XML/SVG text. */
function looksLikeImage(ext: string, head: Buffer): boolean {
  switch (ext) {
    case '.png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case '.jpg':
    case '.jpeg':
      return head[0] === 0xff && head[1] === 0xd8
    case '.gif':
      return head.subarray(0, 4).toString('latin1') === 'GIF8'
    case '.webp':
      return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP'
    case '.svg':
      return /<(\?xml|svg)/i.test(head.toString('utf8'))
    default:
      return false
  }
}

const inside = (root: string, target: string) => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const toEntry = (path: string, mtimeMs: number): ImageEntry => ({ name: basename(path), path, mtime: mtimeMs })

// ---------- uploads ----------

function uploadName(ext: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) // 20260919T101500
  return `img-${stamp}-${randomBytes(3).toString('hex')}.${ext}`
}

async function pruneUploads(fs: MachineFs, dir: string): Promise<void> {
  try {
    const files = (await fs.listFiles(dir)).filter((f) => UPLOAD_NAME.test(basename(f.path)))
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const now = Date.now()
    const doomed = files.filter((f, i) => i >= UPLOAD_MAX_FILES || now - f.mtimeMs > UPLOAD_MAX_AGE_MS)
    await Promise.all(doomed.map((f) => fs.remove(f.path)))
  } catch {
    // Housekeeping must never fail the upload the user is waiting on.
  }
}

export async function saveUpload(fs: MachineFs, cwd: string, mime: string | undefined, data: Buffer): Promise<string> {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') {
    throw new HttpError(415, 'HEIC photos are not supported — share it as JPEG or PNG')
  }
  const ext = UPLOAD_EXT[type]
  if (!ext) throw new HttpError(415, `unsupported image type: ${type || 'unknown'}`)
  if (data.length === 0) throw new HttpError(400, 'empty upload')
  if (!looksLikeImage(`.${ext}`, data.subarray(0, 64))) throw new HttpError(415, 'file is not a valid image')

  const dir = join(cwd, UPLOAD_DIR)
  const path = join(dir, uploadName(ext))
  await fs.writeNew(path, data)
  void fs.excludeFromGit(cwd).catch(() => undefined)
  void pruneUploads(fs, dir)
  return path
}

export async function listUploads(fs: MachineFs, cwd: string): Promise<ImageEntry[]> {
  const files = (await fs.listFiles(join(cwd, UPLOAD_DIR))).filter((f) => UPLOAD_NAME.test(basename(f.path)))
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => toEntry(f.path, f.mtimeMs))
}

// ---------- recent project images ----------

/** Image files changed in the last 48h under `cwd` (screenshots, generated charts, exports). */
export async function recentProjectImages(fs: MachineFs, cwd: string): Promise<ImageEntry[]> {
  const files = await fs.recentFiles({
    root: cwd,
    sinceMs: Date.now() - RECENT_WINDOW_MS,
    maxDepth: WALK_MAX_DEPTH,
    skipDirs: WALK_SKIP,
    excludeDir: join(cwd, '.orca'),
    extensions: Object.keys(IMAGE_MIME),
    limit: RECENT_MAX,
  })
  return files.map((f) => toEntry(f.path, f.mtimeMs))
}

// ---------- serving ----------

export interface ResolvedImage {
  path: string
  mime: string
  size: number
}

/**
 * Resolves a path a pane printed (absolute, `~/…` or relative to the pane) to an image file
 * inside one of `roots` or the machine's temp folder. Symlinks are followed before the
 * containment check.
 */
export async function resolveImage(fs: MachineFs, roots: string[], rawPath: string): Promise<ResolvedImage> {
  const raw = rawPath.trim()
  if (!raw || raw.includes('\0')) throw new HttpError(400, 'missing path')
  const ext = extname(raw).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) throw new HttpError(415, 'not an image file')

  const expanded = raw.startsWith('~/') ? join(fs.home, raw.slice(2)) : raw
  const candidates = isAbsolute(expanded) ? [expanded] : roots.map((r) => resolve(r, expanded))
  const allowed = await Promise.all([...roots, fs.tmp].map(async (r) => (await fs.realpath(r)) ?? r))

  for (const candidate of candidates) {
    const real = await fs.realpath(candidate)
    if (!real) continue
    if (!allowed.some((root) => inside(root, real))) throw new HttpError(403, 'outside the pane’s folders')
    const info = await fs.stat(real)
    if (!info?.isFile) continue
    if (info.size > MAX_SERVE_BYTES) throw new HttpError(413, 'image too large')
    if (!looksLikeImage(ext, await fs.readHead(real, 64))) throw new HttpError(415, 'file is not a valid image')
    return { path: real, mime, size: info.size }
  }
  throw new HttpError(404, `image not found: ${basename(raw)}`)
}

/** Headers for serving a user-controlled image; SVG can carry script, so sandbox it. */
export function imageHeaders(mime: string, size: number): Record<string, string> {
  return {
    'content-type': mime,
    'content-length': String(size),
    'cache-control': 'private, max-age=60',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  }
}
