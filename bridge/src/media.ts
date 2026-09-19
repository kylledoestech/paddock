// Per-pane image routes, relative to a machine (/api/m/:machine/…):
//   POST panes/:id/uploads            raw image body -> { path }
//   GET  panes/:id/media              { session[], project[], uploads[] }
//   GET  panes/:id/image?path=…       a validated image file the pane printed or produced
//   GET  panes/:id/session-image/:n   image n from the pane's Claude session log
// Files are read and written through the machine's MachineFs, so this works over SSH too.
import { posix } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readBinaryBody, sameOrigin, HttpError } from './http.ts'
import { imageHeaders, listUploads, MAX_UPLOAD_BYTES, recentProjectImages, resolveImage, saveUpload, type ImageEntry } from './images.ts'
import type { Machine } from './machines.ts'
import { sessionImages, transcriptFor, type SessionImage } from './transcript.ts'

/** The snapshot fields this module needs from a pane. */
export interface MediaPane {
  pane_id: string
  cwd: string
  foreground_cwd?: string
  agent?: string
  agent_session?: { agent?: string; kind?: string; value?: string }
}

interface MediaItem {
  name: string
  path: string
  mtime: number
  url: string
}

/** Folders images may be served from: where the pane's program runs, then the pane's own cwd. */
const paneRoots = (pane: MediaPane) => [...new Set([pane.foreground_cwd, pane.cwd].filter((p): p is string => !!p))]

function routes(machine: Machine, paneId: string) {
  const base = `/api/m/${encodeURIComponent(machine.id)}/panes/${encodeURIComponent(paneId)}`
  return {
    file: (path: string) => `${base}/image?path=${encodeURIComponent(path)}`,
    session: (n: number) => `${base}/session-image/${n}`,
  }
}

async function paneSessionImages(machine: Machine, pane: MediaPane): Promise<SessionImage[]> {
  if (pane.agent !== 'claude') return []
  // herdr keeps the last announced session even after the pane changes agent; only trust a matching one.
  const session = pane.agent_session?.agent === 'claude' ? pane.agent_session.value : undefined
  const path = await transcriptFor(machine.fs, machine.id, session, paneRoots(pane))
  return path ? sessionImages(machine.fs, machine.id, path) : []
}

async function listMedia(machine: Machine, pane: MediaPane) {
  const url = routes(machine, pane.pane_id)
  const toItems = (entries: ImageEntry[]): MediaItem[] => entries.map((e) => ({ ...e, url: url.file(e.path) }))
  const [session, project, uploads] = await Promise.all([
    paneSessionImages(machine, pane).catch(() => []),
    recentProjectImages(machine.fs, pane.foreground_cwd || pane.cwd).catch(() => []),
    listUploads(machine.fs, pane.cwd).catch(() => []),
  ])
  const sessionItems: MediaItem[] = session
    .map((img, n) => ({
      name: img.kind === 'file' ? posix.basename(img.path) : `Image ${n + 1}`,
      path: img.kind === 'file' ? img.path : '',
      mtime: img.timestamp,
      url: url.session(n),
    }))
    .reverse() // Newest first, like the other groups.
  return { session: sessionItems, project: toItems(project), uploads: toItems(uploads) }
}

function streamFile(res: ServerResponse, machine: Machine, path: string, mime: string, size: number): void {
  res.writeHead(200, imageHeaders(mime, size))
  const stream = machine.fs.readStream(path)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/** Handles `rest` (the path after /api/m/:machine) when it is a media route; returns false otherwise. */
export async function handleMedia(
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
  url: URL,
  machine: Machine,
  findPane: (paneId: string) => MediaPane | undefined,
): Promise<boolean> {
  const match = rest.match(/^\/panes\/([^/]+)\/(uploads|media|image|session-image\/(\d+))$/)
  if (!match) return false
  const pane = findPane(decodeURIComponent(match[1]))
  if (!pane) {
    json(res, 404, { error: 'pane not found' })
    return true
  }
  const route = match[2]

  try {
    if (route === 'uploads' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request rejected')
      const body = await readBinaryBody(req, MAX_UPLOAD_BYTES)
      const path = await saveUpload(machine.fs, pane.cwd, req.headers['content-type'], body)
      json(res, 201, { path })
      return true
    }
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')

    if (route === 'media') {
      json(res, 200, await listMedia(machine, pane))
      return true
    }

    if (route === 'image') {
      const image = await resolveImage(machine.fs, paneRoots(pane), url.searchParams.get('path') ?? '')
      streamFile(res, machine, image.path, image.mime, image.size)
      return true
    }

    // session-image/:n
    const images = await paneSessionImages(machine, pane)
    const image = images[Number(match[3])]
    if (!image) throw new HttpError(404, 'image not found')
    if (image.kind === 'inline') {
      const data = Buffer.from(image.data, 'base64')
      res.writeHead(200, imageHeaders(image.mime, data.length))
      res.end(data)
    } else {
      // Claude referenced this file itself, so its own folder is an allowed root.
      const file = await resolveImage(machine.fs, [posix.dirname(image.path)], image.path)
      streamFile(res, machine, file.path, file.mime, file.size)
    }
    return true
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    json(res, status, { error: (err as Error).message })
    return true
  }
}
