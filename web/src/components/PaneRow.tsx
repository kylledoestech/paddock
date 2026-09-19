import type { Pane, Snapshot } from '../types/herdr'
import { isShell, paneTitle, tabFor } from '../data/selectors'
import { StatusDot } from './StatusDot'

export function PaneRow({
  snapshot,
  pane,
  active = false,
  onOpen,
}: {
  snapshot: Snapshot
  pane: Pane
  /** The pane open in the desktop terminal. */
  active?: boolean
  onOpen: () => void
}) {
  const shell = isShell(pane)
  return (
    <button className={`pane-row${active ? ' pane-row--active' : ''}`} aria-current={active} onClick={onOpen}>
      <StatusDot status={shell ? 'unknown' : pane.agent_status} />
      <span className={`pane-row__agent ellipsis${shell ? ' pane-row__agent--shell' : ''}`}>
        {shell ? 'shell' : pane.agent}
      </span>
      <span className="pane-row__title ellipsis">{paneTitle(pane)}</span>
      <span className="pane-row__tab">{tabFor(snapshot, pane)?.label}</span>
    </button>
  )
}
