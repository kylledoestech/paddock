import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '../data/live'
import { ChevronLeft, ChevronRight, Close, Download } from './icons'

const SWIPE_PX = 60

function timeLabel(mtime: number): string {
  const d = new Date(mtime)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** Full-screen image with native pinch-zoom; swipe or arrows move through the group. */
export function ImageViewer({ items, start, onClose }: { items: MediaItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start)
  const [failed, setFailed] = useState(false)
  const touchX = useRef<number | null>(null)
  const item = items[index]
  const hasPrev = index > 0
  const hasNext = index < items.length - 1

  useEffect(() => setFailed(false), [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && hasPrev) setIndex((i) => i - 1)
      if (e.key === 'ArrowRight' && hasNext) setIndex((i) => i + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, hasPrev, hasNext])

  if (!item) return null

  // Only a single-finger horizontal swipe navigates; two fingers are pinch-zoom.
  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches.length === 1 ? e.touches[0].clientX : null
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current === null || window.visualViewport?.scale !== 1) return
    const dx = e.changedTouches[0].clientX - touchX.current
    touchX.current = null
    if (dx > SWIPE_PX && hasPrev) setIndex(index - 1)
    if (dx < -SWIPE_PX && hasNext) setIndex(index + 1)
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={item.name}>
      <header className="viewer__head">
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          <Close />
        </button>
        <div className="viewer__title">
          <span className="ellipsis">{item.name}</span>
          <span className="viewer__sub ellipsis">
            {timeLabel(item.mtime)}
            {items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}
          </span>
        </div>
        <a className="icon-button" href={item.url} download={item.name} aria-label="Download">
          <Download />
        </a>
      </header>
      <div className="viewer__stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {failed ? (
          <p className="viewer__error">Couldn’t load this image. It may have moved or be outside the project.</p>
        ) : (
          <img className="viewer__img" src={item.url} alt={item.name} onError={() => setFailed(true)} />
        )}
        {hasPrev && (
          <button className="viewer__nav viewer__nav--prev" aria-label="Previous image" onClick={() => setIndex(index - 1)}>
            <ChevronLeft />
          </button>
        )}
        {hasNext && (
          <button className="viewer__nav viewer__nav--next" aria-label="Next image" onClick={() => setIndex(index + 1)}>
            <ChevronRight />
          </button>
        )}
      </div>
    </div>
  )
}
