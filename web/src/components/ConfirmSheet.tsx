import { useState } from 'react'
import { useStore } from '../data/store'
import { Sheet } from './Sheet'

/** A destructive action behind one explicit tap, with a plain explanation of what it ends. */
export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  onConfirm,
  onBack,
  onClose,
}: {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
  onBack?: () => void
  onClose: () => void
}) {
  const { notify } = useStore()
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      notify('error', `${confirmLabel} failed: ${(err as Error).message}`)
      setBusy(false)
    }
  }

  return (
    <Sheet title={title} onClose={onClose} onBack={onBack}>
      <div className="form">
        <p className="sheet__text">{message}</p>
        <div className="button-row">
          <button className="secondary-button" onClick={onBack ?? onClose} disabled={busy}>
            Cancel
          </button>
          <button className="danger-button" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Closing…' : confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  )
}
