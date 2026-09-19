import { useEffect, useRef, useState } from 'react'
import { useStore } from '../data/store'
import { groupPanesByWorkspace, paneTitle, shellCount, tabFor, type WorkspaceGroup as Group } from '../data/selectors'
import { Header } from '../components/Header'
import { NeedsYou } from '../components/NeedsYou'
import { WorkspaceGroup } from '../components/WorkspaceGroup'
import { MachineSheet } from '../components/MachineSheet'
import { NewSheet } from '../components/NewSheet'
import { NotificationsSheet } from '../components/NotificationsSheet'
import { pushStatus, type PushStatus } from '../data/push'
import { ActionSheet } from '../components/ActionSheet'
import { RenameSheet } from '../components/RenameSheet'
import { ConfirmSheet } from '../components/ConfirmSheet'
import type { Snapshot, Workspace } from '../types/herdr'
import { Pencil, Plus, Search, Trash } from '../components/icons'
import { BuildTag } from '../components/BuildTag'

type OpenSheet =
  | { kind: 'none' | 'machines' | 'new' | 'notifications' }
  | { kind: 'space' | 'rename-space' | 'close-space'; workspace: Workspace }

/** Groups whose space, tab, agent or pane title contains `query` (panes filtered too). */
function filterGroups(groups: Group[], query: string, snapshot: Snapshot): Group[] {
  const q = query.trim().toLowerCase()
  if (!q) return groups
  return groups
    .map((g) => {
      if (g.workspace.label.toLowerCase().includes(q)) return g
      const panes = g.panes.filter((p) =>
        [p.agent ?? 'shell', paneTitle(p), tabFor(snapshot, p)?.label ?? ''].some((s) => s.toLowerCase().includes(q)),
      )
      return { ...g, panes }
    })
    .filter((g) => g.panes.length > 0)
}

export function Home({
  onOpenPane,
  sidebar = false,
  activePaneId,
}: {
  onOpenPane: (paneId: string, machineId?: string) => void
  /** Desktop: rendered as the left sidebar next to the terminal. */
  sidebar?: boolean
  activePaneId?: string
}) {
  const { machine, machines, showShells, connected, link, api } = useStore()
  const [sheet, setSheetState] = useState<OpenSheet>({ kind: 'none' })
  const setSheet = (kind: 'none' | 'machines' | 'new' | 'notifications') => setSheetState({ kind })
  const [push, setPush] = useState<PushStatus | null>(null)
  useEffect(() => void pushStatus().then(setPush), [])
  // Warm the terminal (xterm chunk + mono font) while idle, so opening a pane doesn't wait on them.
  useEffect(() => {
    const warm = () => {
      void import('../components/LiveTerminal')
      void document.fonts.load('13px "JetBrains Mono"')
    }
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500))
    idle(warm)
  }, [])
  const snapshot = machine.online ? machine.snapshot : null
  const groups = snapshot ? groupPanesByWorkspace(snapshot, showShells) : []
  const hiddenShells = snapshot && !showShells ? shellCount(snapshot) : 0
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // A search looks through hidden shells too.
  const shown = snapshot ? (query.trim() ? filterGroups(groupPanesByWorkspace(snapshot, true), query, snapshot) : groups) : []

  // Desktop: ⌘K / Ctrl+K jumps to the pane search.
  useEffect(() => {
    if (!sidebar) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebar])

  return (
    <div className="scroller">
      <main className={`home${sidebar ? ' home--sidebar' : ''}`}>
        <Header
          compact={sidebar}
          onOpenMachines={() => setSheet('machines')}
          onOpenNotifications={() => setSheet('notifications')}
          notificationsOff={push === 'off' || push === 'insecure'}
        />
        {link === 'reconnecting' && connected && (
          <div className="link-status" role="status">
            <span className="spinner spinner--small" aria-hidden="true" />
            Reconnecting… showing last known state
          </div>
        )}

        {sidebar && snapshot && (
          <label className="side-search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
                // Enter opens the first match.
                const first = shown[0]?.panes[0]
                if (e.key === 'Enter' && first) onOpenPane(first.pane_id)
              }}
              placeholder="Jump to pane"
              aria-label="Jump to pane"
            />
            <kbd>⌘K</kbd>
          </label>
        )}

        {/* Agents waiting on you anywhere, not just on the selected machine. */}
        <NeedsYou machines={machines} onOpenPane={onOpenPane} />

        {!snapshot ? (
          <div className="banner" role="status">
            <strong>
              {!connected
                ? 'Connecting…'
                : machine.status === 'attention'
                  ? `${machine.label} needs attention`
                  : `${machine.label} is offline`}
            </strong>
            {!connected
              ? 'Waiting for the Orca bridge.'
              : machine.status === 'attention'
                ? `SSH says: ${machine.error ?? 'login failed'}. Check the key and host, then Orca retries on its own.`
                : 'Orca can’t reach herdr on this machine. It will reconnect automatically.'}
          </div>
        ) : groups.length === 0 ? (
          <div className="banner">
            <strong>No agents running</strong>
            {sidebar ? 'Use New below to start one.' : 'Tap + to start one.'}
          </div>
        ) : (
          <div className="map">
            {shown.length === 0 && <div className="footer-note">No pane matches “{query}”</div>}
            {shown.map((g) => (
              <WorkspaceGroup
                key={g.workspace.workspace_id}
                snapshot={snapshot}
                group={g}
                activePaneId={activePaneId}
                onOpenPane={(paneId) => onOpenPane(paneId)}
                onActions={(workspace) => setSheetState({ kind: 'space', workspace })}
              />
            ))}
            {hiddenShells > 0 && (
              <div className="footer-note">
                {hiddenShells} {hiddenShells === 1 ? 'shell' : 'shells'} hidden
              </div>
            )}
          </div>
        )}

        {sidebar && snapshot && (
          <button className="side-new" aria-haspopup="dialog" onClick={() => setSheet('new')}>
            <Plus size={16} />
            New agent, terminal or space
          </button>
        )}

        <BuildTag />

        {snapshot && !sidebar && (
          <button className="fab" aria-label="New agent or worktree" aria-haspopup="dialog" onClick={() => setSheet('new')}>
            <Plus size={22} />
          </button>
        )}

        {sheet.kind === 'machines' && <MachineSheet onClose={() => setSheet('none')} />}
        {sheet.kind === 'new' && <NewSheet onClose={() => setSheet('none')} onOpenPane={(paneId) => onOpenPane(paneId)} />}
        {sheet.kind === 'notifications' && <NotificationsSheet onClose={() => setSheet('none')} onChange={setPush} />}
        {sheet.kind === 'space' && (
          <ActionSheet
            title={sheet.workspace.label}
            onClose={() => setSheet('none')}
            actions={[
              {
                title: 'Rename space',
                Icon: Pencil,
                onSelect: () => setSheetState({ kind: 'rename-space', workspace: sheet.workspace }),
              },
              {
                title: 'Close space',
                desc: `Ends everything in its ${sheet.workspace.pane_count} ${sheet.workspace.pane_count === 1 ? 'pane' : 'panes'}`,
                Icon: Trash,
                onSelect: () => setSheetState({ kind: 'close-space', workspace: sheet.workspace }),
              },
            ]}
          />
        )}
        {sheet.kind === 'close-space' && (
          <ConfirmSheet
            title="Close space?"
            message={`Closes “${sheet.workspace.label}” and ends everything in its ${sheet.workspace.pane_count} ${
              sheet.workspace.pane_count === 1 ? 'pane' : 'panes'
            }, agents included. This can’t be undone.`}
            confirmLabel="Close space"
            onConfirm={() => api.closeWorkspace(sheet.workspace.workspace_id)}
            onBack={() => setSheetState({ kind: 'space', workspace: sheet.workspace })}
            onClose={() => setSheet('none')}
          />
        )}
        {sheet.kind === 'rename-space' && (
          <RenameSheet
            title="Rename space"
            fieldLabel="Space name"
            initial={sheet.workspace.label}
            onSave={(label) => api.renameWorkspace(sheet.workspace.workspace_id, label)}
            onBack={() => setSheetState({ kind: 'space', workspace: sheet.workspace })}
            onClose={() => setSheet('none')}
          />
        )}
      </main>
    </div>
  )
}
