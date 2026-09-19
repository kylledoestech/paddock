// Images from a pane's Claude Code session log (~/.claude/projects/<dir>/<session>.jsonl):
// images pasted into prompts, images Claude looked at (Read tool results), and image files
// Claude read or wrote. The log format is internal to Claude Code, so parsing is defensive.
// Works on any machine: the log is streamed through its MachineFs and parsed here.
import { posix } from 'node:path'
import { createInterface } from 'node:readline'
import type { MachineFs } from './fsops.ts'
import { IMAGE_MIME } from './images.ts'

const { extname, join } = posix
const KEEP = 100
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type SessionImage =
  | { kind: 'inline'; mime: string; data: string; timestamp: number }
  | { kind: 'file'; path: string; timestamp: number }

interface CacheEntry {
  size: number
  mtime: number
  images: SessionImage[]
}

// Keyed by `<machine>:<path>`: logs are parsed once and re-read only when they change.
const cache = new Map<string, CacheEntry>()
const pathById = new Map<string, string>()

const projectsDir = (fs: MachineFs) =>
  fs.home === process.env.HOME && process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(fs.home, '.claude', 'projects')

/** Claude Code names a project folder after its cwd with every non-alphanumeric turned into `-`. */
const projectDirFor = (fs: MachineFs, cwd: string) => join(projectsDir(fs), cwd.replace(/[^a-zA-Z0-9]/g, '-'))

/**
 * The session log for a pane: herdr's stored session id when the claude integration reported
 * one, else the most recently written log for the pane's folder.
 */
export async function transcriptFor(
  fs: MachineFs,
  machineId: string,
  sessionId: string | undefined,
  cwds: string[],
): Promise<string | null> {
  if (sessionId && SESSION_ID.test(sessionId)) {
    const key = `${machineId}:${sessionId}`
    const cached = pathById.get(key)
    if (cached) return cached
    const found = await fs.findInSubdirs(projectsDir(fs), `${sessionId}.jsonl`)
    if (found) {
      pathById.set(key, found)
      return found
    }
  }
  for (const cwd of cwds) {
    const newest = await fs.newestJsonl(projectDirFor(fs, cwd))
    if (newest) return newest
  }
  return null
}

/**
 * `fileToolUses` holds ids of tool calls on image files; their results repeat the same image
 * inline, so those copies are skipped in favour of the file entry.
 */
function collect(node: unknown, timestamp: number, out: SessionImage[], fileToolUses: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, timestamp, out, fileToolUses)
    return
  }
  if (!node || typeof node !== 'object') return
  const block = node as Record<string, unknown>
  if (block.type === 'image') {
    const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
    if (source?.type === 'base64' && typeof source.data === 'string' && source.media_type?.startsWith('image/')) {
      out.push({ kind: 'inline', mime: source.media_type, data: source.data, timestamp })
    }
    return
  }
  if (block.type === 'tool_use') {
    const input = block.input as { file_path?: unknown } | undefined
    const path = input?.file_path
    if (typeof path === 'string' && extname(path).toLowerCase() in IMAGE_MIME) {
      out.push({ kind: 'file', path, timestamp })
      if (typeof block.id === 'string') fileToolUses.add(block.id)
    }
    return
  }
  if (block.type === 'tool_result') {
    if (typeof block.tool_use_id === 'string' && fileToolUses.has(block.tool_use_id)) return
    collect(block.content, timestamp, out, fileToolUses)
  } else if ('content' in block) collect(block.content, timestamp, out, fileToolUses)
}

/** Images in the log, oldest first, last {@link KEEP}. Cached until the file changes. */
export async function sessionImages(fs: MachineFs, machineId: string, transcriptPath: string): Promise<SessionImage[]> {
  const info = await fs.stat(transcriptPath)
  if (!info) return []
  const key = `${machineId}:${transcriptPath}`
  const hit = cache.get(key)
  if (hit && hit.size === info.size && hit.mtime === info.mtimeMs) return hit.images

  const images: SessionImage[] = []
  const fileToolUses = new Set<string>()
  const lines = createInterface({ input: fs.readStream(transcriptPath), crlfDelay: Infinity })
  for await (const line of lines) {
    // Cheap pre-filter: most lines have no images or image paths.
    if (!line.includes('"image"') && !/\.(png|jpe?g|webp|gif|svg)"/i.test(line)) continue
    let row: { type?: string; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue // A partially written last line.
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isSidechain) continue
    collect(row.message?.content, Date.parse(row.timestamp ?? '') || info.mtimeMs, images, fileToolUses)
  }

  // A file Claude touched more than once (read, then edited) keeps only its latest mention.
  const deduped: SessionImage[] = []
  const seenPaths = new Set<string>()
  for (let i = images.length - 1; i >= 0; i--) {
    const img = images[i]
    if (img.kind === 'file') {
      if (seenPaths.has(img.path)) continue
      seenPaths.add(img.path)
    }
    deduped.unshift(img)
  }
  const kept = deduped.slice(-KEEP)
  cache.set(key, { size: info.size, mtime: info.mtimeMs, images: kept })
  if (cache.size > 8) cache.delete(cache.keys().next().value!)
  return kept
}
