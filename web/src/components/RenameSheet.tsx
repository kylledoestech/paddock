import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useStore } from '../data/store'
import { Sheet } from './Sheet'

const LABEL_MAX = 60

/** One text field to rename a space or tab; herdr's rename event updates the UI afterwards. */
export function RenameSheet({
  title,
  fieldLabel,
  initial,
  onSave,
  onBack,
  onClose,
}: {
  title: string
  fieldLabel: string
  initial: string
  onSave: (label: string) => Promise<unknown>
  onBack?: () => void
  onClose: () => void
}) {
  const { notify } = useStore()
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const label = value.trim()

  useEffect(() => inputRef.current?.select(), [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!label || label === initial) return
    setSaving(true)
    try {
      await onSave(label)
      onClose()
    } catch (err) {
      notify('error', `Rename failed: ${(err as Error).message}`)
      setSaving(false)
    }
  }

  return (
    <Sheet title={title} onClose={onClose} onBack={onBack}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span className="field__label">{fieldLabel}</span>
          <input
            ref={inputRef}
            className="field__control"
            value={value}
            maxLength={LABEL_MAX}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
          />
        </label>
        <button className="primary-button" type="submit" disabled={saving || !label || label === initial}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Sheet>
  )
}
