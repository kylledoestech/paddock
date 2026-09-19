import { useCallback, useEffect, useState } from 'react'
import { imageUrl, type MediaItem, type PaneMedia } from '../data/live'
import { useStore } from '../data/store'
import { Sheet } from './Sheet'
import { Refresh } from './icons'

interface Group {
  key: string
  title: string
  items: MediaItem[]
}

/**
 * Images for one pane: paths currently on screen, the Claude session's images,
 * images recently changed in the project, and phone uploads.
 */
export function MediaSheet({
  paneId,
  screenPaths,
  onOpen,
  onClose,
}: {
  paneId: string
  screenPaths: string[]
  onOpen: (items: MediaItem[], index: number) => void
  onClose: () => void
}) {
  const { api, machine } = useStore()
  const [media, setMedia] = useState<PaneMedia | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Paths found in terminal text are guesses (often relative to a source file, not the pane);
  // any image that fails to load is dropped instead of showing a broken tile.
  const [broken, setBroken] = useState<Set<string>>(() => new Set())
  const markBroken = (url: string) => setBroken((prev) => new Set(prev).add(url))

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api
      .media(paneId)
      .then(setMedia, (err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [api, paneId])

  useEffect(load, [load])

  const onScreen: MediaItem[] = screenPaths.map((path) => ({
    name: path.split('/').pop() ?? path,
    path,
    mtime: Date.now(),
    url: imageUrl(machine.id, paneId, path),
  }))

  const groups: Group[] = [
    { key: 'screen', title: 'On screen', items: onScreen },
    { key: 'session', title: 'Claude session', items: media?.session ?? [] },
    { key: 'project', title: 'Recent in project', items: media?.project ?? [] },
    { key: 'uploads', title: 'Uploads', items: media?.uploads ?? [] },
  ]
    .map((g) => ({ ...g, items: g.items.filter((item) => !broken.has(item.url)) }))
    .filter((g) => g.items.length > 0)

  return (
    <Sheet title="Media" onClose={onClose}>
      <div className="media">
        <button className="media__refresh" onClick={load} disabled={loading}>
          <Refresh size={16} className={loading ? 'spin' : undefined} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {error && <p className="media__empty">Couldn’t load media: {error}</p>}
        {!loading && !error && groups.length === 0 && (
          <p className="media__empty">No images yet. Upload one with the photo key, or ask the agent to make one.</p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="media__group" aria-label={group.title}>
            <h3 className="media__title">
              {group.title}
              <span>{group.items.length}</span>
            </h3>
            <div className="media__grid">
              {group.items.map((item, i) => (
                <button key={item.url} className="media__thumb" aria-label={`Open ${item.name}`} onClick={() => onOpen(group.items, i)}>
                  <img src={item.url} alt="" loading="lazy" decoding="async" onError={() => markBroken(item.url)} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Sheet>
  )
}
