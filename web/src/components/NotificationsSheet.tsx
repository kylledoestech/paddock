import { useEffect, useState } from 'react'
import { useStore } from '../data/store'
import {
  disablePush,
  enablePush,
  loadPrefs,
  pushStatus,
  sendTest,
  updatePrefs,
  type PushKind,
  type PushPrefs,
  type PushStatus,
} from '../data/push'
import { Sheet } from './Sheet'

const KINDS: { kind: PushKind; title: string; desc: string }[] = [
  { kind: 'blocked', title: 'Needs your input', desc: 'Permission prompts, questions, plan approval' },
  { kind: 'done', title: 'Finished', desc: 'An agent stopped working' },
  { kind: 'exited', title: 'Exited', desc: 'An agent quit or its pane closed' },
]

const STATUS_TEXT: Record<PushStatus, string> = {
  unsupported: 'This browser can’t receive push notifications. On iPhone, add Orca to the Home Screen first.',
  insecure: 'Notifications need the HTTPS address: open Orca at https://<machine>.ts.net.',
  denied: 'Notifications are blocked for Orca. Allow them in the browser’s site settings (Android: tap the lock icon → Permissions → Notifications), then come back.',
  off: 'Get a notification when an agent needs you, finishes or exits. Quiet for the pane you have open.',
  on: 'On for this device. Quiet for the pane you have open.',
}

export function NotificationsSheet({ onClose, onChange }: { onClose: () => void; onChange: (status: PushStatus) => void }) {
  const { notify } = useStore()
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [prefs, setPrefs] = useState<PushPrefs>(loadPrefs)
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    void pushStatus().then((s) => {
      setStatus(s)
      onChange(s)
    })
  useEffect(refresh, [])

  const run = async (task: () => Promise<void>, success?: string) => {
    setBusy(true)
    try {
      await task()
      if (success) notify('info', success)
    } catch (err) {
      notify('error', `Notifications: ${(err as Error).message}`)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const toggle = (kind: PushKind) => {
    const next = { ...prefs, [kind]: !prefs[kind] }
    setPrefs(next)
    if (status === 'on') void run(() => updatePrefs(next))
  }

  return (
    <Sheet title="Notifications" onClose={onClose}>
      <div className="form">
        <p className="sheet__text">{status ? STATUS_TEXT[status] : 'Checking…'}</p>

        {status === 'off' && (
          <button className="primary-button" disabled={busy} onClick={() => void run(() => enablePush(prefs), 'Test notification sent')}>
            {busy ? 'Enabling…' : 'Enable notifications'}
          </button>
        )}

        {(status === 'on' || status === 'off') && (
          <div className="choice-list" role="group" aria-label="Notify me when">
            {KINDS.map(({ kind, title, desc }) => (
              <label key={kind} className="choice toggle-row">
                <span className="choice__text">
                  <span className="choice__title">{title}</span>
                  <span className="choice__desc">{desc}</span>
                </span>
                <input type="checkbox" className="switch" checked={prefs[kind]} onChange={() => toggle(kind)} />
              </label>
            ))}
          </div>
        )}

        {status === 'on' && (
          <div className="button-row">
            <button className="secondary-button" disabled={busy} onClick={() => void run(sendTest, 'Test notification sent')}>
              Send test
            </button>
            <button className="secondary-button" disabled={busy} onClick={() => void run(disablePush, 'Notifications off')}>
              Turn off
            </button>
          </div>
        )}
      </div>
    </Sheet>
  )
}
