import { useStore } from '../data/store'
import { needsYou } from '../data/selectors'
import { Bell, ChevronDown } from './icons'

export function Header({
  onOpenMachines,
  onOpenNotifications,
  notificationsOff,
  compact = false,
}: {
  onOpenMachines: () => void
  onOpenNotifications: () => void
  /** Shows a dot on the bell until notifications are set up on this device. */
  notificationsOff: boolean
  /** Desktop sidebar: title, machine and actions on one row. */
  compact?: boolean
}) {
  const { machine, machines } = useStore()
  // Other machines are hidden from the list now, so their waiting agents show as a count here.
  const elsewhere = machines
    .filter((m) => m.id !== machine.id && m.snapshot)
    .reduce((n, m) => n + needsYou(m.snapshot!).filter((p) => p.agent_status === 'blocked').length, 0)
  return (
    <>
      <div className={`header${compact ? ' header--compact' : ''}`}>
        {compact && <span className="header__brand">Paddock</span>}
        <button className="machine-button" onClick={onOpenMachines} aria-haspopup="dialog">
          <span
            className={`dot dot--small dot--${machine.online ? 'online' : machine.status === 'attention' ? 'blocked' : 'offline'}`}
            aria-hidden="true"
          />
          {machine.label}
          {elsewhere > 0 && (
            <span className="machine-button__badge" aria-label={`${elsewhere} waiting on other machines`}>
              {elsewhere}
            </span>
          )}
          <ChevronDown size={14} strokeWidth={2} />
          <span className="visually-hidden">Switch machine</span>
        </button>
        <div className="header__actions">
          <button className="icon-button bell" aria-label="Notifications" aria-haspopup="dialog" onClick={onOpenNotifications}>
            <Bell />
            {notificationsOff && <span className="bell__dot" aria-hidden="true" />}
          </button>
        </div>
      </div>
      {!compact && <h1 className="title">Paddock</h1>}
    </>
  )
}
