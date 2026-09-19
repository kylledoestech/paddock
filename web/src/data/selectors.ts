import type { Pane, Snapshot, Tab, Workspace } from '../types/herdr'

export const isShell = (pane: Pane): boolean => !pane.agent

export const paneTitle = (pane: Pane): string =>
  pane.terminal_title_stripped || pane.terminal_title || pane.cwd

/** Agents waiting on the user: blocked first, then done. */
export function needsYou(snapshot: Snapshot): Pane[] {
  const order = { blocked: 0, done: 1 } as const
  return snapshot.panes
    .filter((p) => !isShell(p) && (p.agent_status === 'blocked' || p.agent_status === 'done'))
    .sort((a, b) => order[a.agent_status as 'blocked' | 'done'] - order[b.agent_status as 'blocked' | 'done'])
}

export interface WorkspaceGroup {
  workspace: Workspace
  panes: Pane[]
}

/** Workspaces in herdr order, each with its panes flattened across tabs. */
export function groupPanesByWorkspace(snapshot: Snapshot, showShells: boolean): WorkspaceGroup[] {
  return [...snapshot.workspaces]
    .sort((a, b) => a.number - b.number)
    .map((workspace) => ({
      workspace,
      panes: snapshot.panes.filter(
        (p) => p.workspace_id === workspace.workspace_id && (showShells || !isShell(p)),
      ),
    }))
    .filter((g) => g.panes.length > 0)
}

export const shellCount = (snapshot: Snapshot): number => snapshot.panes.filter(isShell).length

export function tabFor(snapshot: Snapshot, pane: Pane): Tab | undefined {
  return snapshot.tabs.find((t) => t.tab_id === pane.tab_id)
}

export function workspaceFor(snapshot: Snapshot, pane: Pane): Workspace | undefined {
  return snapshot.workspaces.find((w) => w.workspace_id === pane.workspace_id)
}
