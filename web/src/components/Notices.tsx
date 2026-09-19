import { useEffect } from 'react'
import { useStore } from '../data/store'
import type { Notice } from '../data/live'
import { Close } from './icons'

const TTL_MS = 5000

function NoticeItem({ notice }: { notice: Notice }) {
  const { dispatch } = useStore()
  useEffect(() => {
    const t = window.setTimeout(() => dispatch({ type: 'dismissNotice', id: notice.id }), TTL_MS)
    return () => window.clearTimeout(t)
  }, [notice.id, dispatch])

  return (
    <div className={`notice notice--${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}>
      <span className="notice__text">{notice.message}</span>
      <button className="icon-button" aria-label="Dismiss" onClick={() => dispatch({ type: 'dismissNotice', id: notice.id })}>
        <Close size={16} />
      </button>
    </div>
  )
}

export function Notices() {
  const { notices } = useStore()
  if (notices.length === 0) return null
  return (
    <div className="notices">
      {notices.map((n) => (
        <NoticeItem key={n.id} notice={n} />
      ))}
    </div>
  )
}
