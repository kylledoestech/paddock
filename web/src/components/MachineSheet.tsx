import { useStore } from '../data/store'
import type { Machine } from '../types/herdr'
import { Sheet } from './Sheet'
import { Check } from './icons'

function describe(m: Machine): string {
  if (m.status === 'online' && m.snapshot) {
    const spaces = m.snapshot.workspaces.length
    return `herdr ${m.snapshot.version} · ${spaces} ${spaces === 1 ? 'space' : 'spaces'}${m.kind === 'ssh' ? ' · SSH' : ''}`
  }
  if (m.status === 'attention') return `Needs attention: ${m.error ?? 'SSH login failed'}`
  return m.error && m.error !== 'connecting' ? `Offline — reconnecting (${m.error})` : 'Connecting…'
}

export function MachineSheet({ onClose }: { onClose: () => void }) {
  const { machines, machineId, dispatch } = useStore()
  return (
    <Sheet title="Machines" onClose={onClose}>
      <div className="form">
        <div className="choice-list">
          {machines.map((m) => (
            <button
              key={m.id}
              className="choice"
              aria-current={m.id === machineId}
              onClick={() => {
                dispatch({ type: 'selectMachine', id: m.id })
                onClose()
              }}
            >
              <span className={`dot dot--${m.status === 'online' ? 'online' : m.status === 'attention' ? 'blocked' : 'offline'}`} aria-hidden="true" />
              <span className="choice__text">
                <span className="choice__title">{m.label}</span>
                <span className="choice__desc">{describe(m)}</span>
              </span>
              {m.id === machineId && <Check className="choice__check" />}
            </button>
          ))}
        </div>
        <p className="sheet__text">
          To add a machine, run <code>herdr machine add ssh://user@host:port</code> on the machine Orca runs on. It
          shows up here within a minute. The machine needs herdr and SSH key login.
        </p>
      </div>
    </Sheet>
  )
}
