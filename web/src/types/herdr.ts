// Shapes mirror herdr's `session.snapshot` response (protocol 22).
// See docs/herdr/herdr-api-schema.json and docs/herdr/herdr-snapshot-sample.json.

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface Workspace {
  workspace_id: string
  label: string
  number: number
  focused: boolean
  active_tab_id: string
  agent_status: AgentStatus
  pane_count: number
  tab_count: number
}

export interface Tab {
  tab_id: string
  workspace_id: string
  label: string
  number: number
  focused: boolean
  agent_status: AgentStatus
  pane_count: number
}

export interface Pane {
  pane_id: string
  tab_id: string
  workspace_id: string
  terminal_id: string
  focused: boolean
  cwd: string
  foreground_cwd?: string
  /** Absent for plain shells. */
  agent?: string
  agent_status: AgentStatus
  terminal_title?: string
  terminal_title_stripped?: string
  revision: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PaneLayout {
  tab_id: string
  workspace_id: string
  zoomed: boolean
  focused_pane_id: string | null
  area: Rect
  panes: { pane_id: string; focused: boolean; rect: Rect }[]
}

export interface Snapshot {
  version: string
  protocol: number
  focused_workspace_id: string | null
  focused_tab_id: string | null
  focused_pane_id: string | null
  workspaces: Workspace[]
  tabs: Tab[]
  panes: Pane[]
  layouts: PaneLayout[]
}

/** A herdr server Paddock can reach. Paddock-side concept, not part of the herdr API. */
export interface Machine {
  id: string
  label: string
  kind: 'local' | 'ssh'
  /** Link and herdr both reachable. */
  online: boolean
  status: 'online' | 'offline' | 'attention'
  error?: string
  snapshot: Snapshot | null
}
