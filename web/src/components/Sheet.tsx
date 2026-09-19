import { useEffect, useRef, type ReactNode } from 'react'
import { Back, Close } from './icons'

export function Sheet({
  title,
  onClose,
  onBack,
  children,
}: {
  title: string
  onClose: () => void
  onBack?: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Keep the latest onClose without re-running the mount effect (which would steal focus).
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__grip" aria-hidden="true" />
        <div className="sheet__head">
          {onBack && (
            <button className="icon-button" aria-label="Back" onClick={onBack}>
              <Back />
            </button>
          )}
          <h2 className="sheet__title">{title}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <Close />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
