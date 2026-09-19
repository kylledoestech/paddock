import type { Machine, Pane } from '../types/herdr'
import { needsYou, paneTitle, workspaceFor } from '../data/selectors'
import { StatusDot } from './StatusDot'
import { ChevronRight } from './icons'

/** Agents waiting on the user across every machine; each row says where when there are several. */
export function NeedsYou({
  machines,
  onOpenPane,
}: {
  machines: Machine[]
  onOpenPane: (paneId: string, machineId: string) => void
}) {
  const rows: { machine: Machine; pane: Pane }[] = machines.flatMap((machine) =>
    machine.snapshot ? needsYou(machine.snapshot).map((pane) => ({ machine, pane })) : [],
  )
  // Blocked before done across machines too.
  rows.sort((a, b) => Number(a.pane.agent_status !== 'blocked') - Number(b.pane.agent_status !== 'blocked'))
  if (rows.length === 0) return null
  const several = machines.filter((m) => m.snapshot).length > 1

  return (
    <section className="needs-you" aria-label="Needs you">
      {rows.map(({ machine, pane }) => (
        <button
          key={`${machine.id}/${pane.pane_id}`}
          className={`needs-row needs-row--${pane.agent_status}`}
          onClick={() => onOpenPane(pane.pane_id, machine.id)}
        >
          <StatusDot status={pane.agent_status} />
          <span className="needs-row__text">
            <span className="needs-row__title ellipsis">{paneTitle(pane)}</span>
            <span className="needs-row__meta ellipsis">
              {pane.agent} · {workspaceFor(machine.snapshot!, pane)?.label}
              {several && ` · ${machine.label}`}
            </span>
          </span>
          <ChevronRight size={16} strokeWidth={2} className="chevron" />
        </button>
      ))}
    </section>
  )
}
