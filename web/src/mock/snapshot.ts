import type { AgentStatus, Machine, Pane, Snapshot, Tab, Workspace } from '../types/herdr'

interface PaneSpec {
  tab: string
  agent?: string
  status: AgentStatus
  title: string
}

interface WorkspaceSpec {
  label: string
  cwd: string
  panes: PaneSpec[]
}

// Worst status wins the roll-up, same ordering the UI uses for attention.
const rank: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 }
const rollup = (statuses: AgentStatus[]): AgentStatus =>
  statuses.reduce<AgentStatus>((a, b) => (rank[b] > rank[a] ? b : a), 'unknown')

function buildSnapshot(specs: WorkspaceSpec[]): Snapshot {
  const workspaces: Workspace[] = []
  const tabs: Tab[] = []
  const panes: Pane[] = []

  specs.forEach((ws, wi) => {
    const wid = `w${wi + 1}`
    const tabLabels = [...new Set(ws.panes.map((p) => p.tab))]
    tabLabels.forEach((label, ti) => {
      const tabPanes = ws.panes.filter((p) => p.tab === label)
      tabs.push({
        tab_id: `${wid}:t${ti + 1}`,
        workspace_id: wid,
        label,
        number: ti + 1,
        focused: ti === 0,
        agent_status: rollup(tabPanes.map((p) => p.status)),
        pane_count: tabPanes.length,
      })
    })
    ws.panes.forEach((p, pi) => {
      const ti = tabLabels.indexOf(p.tab)
      panes.push({
        pane_id: `${wid}:p${pi + 1}`,
        tab_id: `${wid}:t${ti + 1}`,
        workspace_id: wid,
        terminal_id: `term_${wid}p${pi + 1}`,
        focused: pi === 0,
        cwd: ws.cwd,
        agent: p.agent,
        agent_status: p.status,
        terminal_title: p.title,
        terminal_title_stripped: p.title,
        revision: 0,
      })
    })
    workspaces.push({
      workspace_id: wid,
      label: ws.label,
      number: wi + 1,
      focused: wi === 0,
      active_tab_id: `${wid}:t1`,
      agent_status: rollup(ws.panes.map((p) => p.status)),
      pane_count: ws.panes.length,
      tab_count: tabLabels.length,
    })
  })

  return {
    version: '0.9.1',
    protocol: 22,
    focused_workspace_id: workspaces[0]?.workspace_id ?? null,
    focused_tab_id: tabs[0]?.tab_id ?? null,
    focused_pane_id: panes[0]?.pane_id ?? null,
    workspaces,
    tabs,
    panes,
    layouts: [],
  }
}

const desk = buildSnapshot([
  {
    label: 'api',
    cwd: '/home/kylle/src/api',
    panes: [
      { tab: 'main', agent: 'claude', status: 'blocked', title: 'Allow rm -rf dist?' },
      { tab: 'tests', agent: 'codex', status: 'working', title: 'Write integration tests' },
      { tab: 'tests', status: 'idle', title: 'npm test --watch' },
    ],
  },
  {
    label: 'web',
    cwd: '/home/kylle/src/web',
    panes: [
      { tab: 'main', agent: 'codex', status: 'done', title: 'Fix hydration mismatch' },
      { tab: 'design', agent: 'claude', status: 'idle', title: 'Landing page copy' },
      { tab: 'main', status: 'idle', title: 'vite dev' },
    ],
  },
  {
    label: 'paddock',
    cwd: '/home/kylle/paddock',
    panes: [{ tab: 'main', agent: 'claude', status: 'working', title: 'Paddock PWA app for herdr' }],
  },
  {
    label: 'infra',
    cwd: '/home/kylle/src/infra',
    panes: [
      { tab: 'main', agent: 'opencode', status: 'idle', title: 'Terraform drift check' },
      { tab: 'logs', status: 'idle', title: 'journalctl -f' },
    ],
  },
])

export const mockMachines: Machine[] = [
  { id: 'kylle-desk', label: 'kylle-desk', kind: 'local', status: 'online', online: true, snapshot: desk },
  { id: 'homelab', label: 'homelab', kind: 'ssh', status: 'offline', error: 'ssh: connect to host homelab port 22: Connection timed out', online: false, snapshot: null },
]
