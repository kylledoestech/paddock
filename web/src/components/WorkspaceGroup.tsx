import type { Snapshot, Workspace } from '../types/herdr'
import type { WorkspaceGroup as Group } from '../data/selectors'
import { collapseKey, useStore } from '../data/store'
import { PaneRow } from './PaneRow'
import { StatusDot } from './StatusDot'
import { ChevronDown, More } from './icons'

export function WorkspaceGroup({
  snapshot,
  group,
  onOpenPane,
  onActions,
  activePaneId,
}: {
  snapshot: Snapshot
  group: Group
  onOpenPane: (paneId: string) => void
  onActions: (workspace: Workspace) => void
  activePaneId?: string
}) {
  const { machine, collapsed, dispatch } = useStore()
  const key = collapseKey(machine.id, group.workspace.workspace_id)
  const open = !collapsed.includes(key)
  const listId = `ws-${group.workspace.workspace_id}`

  return (
    <section className="ws">
      <div className="ws__row">
        <button
          className="icon-button ws__more"
          aria-label={`Actions for ${group.workspace.label}`}
          aria-haspopup="dialog"
          onClick={() => onActions(group.workspace)}
        >
          <More size={18} />
        </button>
        <button
          className="ws__label"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => dispatch({ type: 'toggleWorkspace', key })}
        >
          <span className="ellipsis">{group.workspace.label}</span>
          <span className="ws__label-end">
            {!open && <StatusDot status={group.workspace.agent_status} small />}
            <span>{group.panes.length}</span>
            <ChevronDown size={14} strokeWidth={2} className="ws__caret" />
          </span>
        </button>
      </div>
      {open && (
        <div className="group" id={listId}>
          {group.panes.map((pane) => (
            <PaneRow
              key={pane.pane_id}
              snapshot={snapshot}
              pane={pane}
              active={pane.pane_id === activePaneId}
              onOpen={() => onOpenPane(pane.pane_id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
