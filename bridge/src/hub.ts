// Keeps one live copy of herdr's session snapshot and tells listeners when it changes.
//
// Strategy (see docs/RESEARCH.md): subscribe to lifecycle events *before* taking the
// snapshot so nothing is missed, then re-snapshot (debounced) on every event instead of
// patching locally. Agent status events are pane-scoped, so a second subscription is
// rebuilt whenever the set of panes changes. A slow poll covers anything events miss.
import { rpc, subscribe, type Subscription } from './herdr.ts'

const LIFECYCLE_EVENTS = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.moved',
  'workspace.reordered', 'workspace.closed', 'workspace.focused',
  'worktree.created', 'worktree.opened', 'worktree.removed',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.focused', 'pane.moved', 'pane.exited',
  'pane.agent_detected', 'layout.updated',
]

const DEBOUNCE_MS = 120
const POLL_MS = 5_000
const RETRY_MS = 2_000

export interface SnapshotPane {
  pane_id: string
}

export interface Snapshot {
  panes: SnapshotPane[]
  [key: string]: unknown
}

export type HubState = { online: true; snapshot: Snapshot } | { online: false; error: string }

type Listener = (state: HubState) => void

export class SnapshotHub {
  state: HubState = { online: false, error: 'connecting' }
  private listeners = new Set<Listener>()
  private lifecycle: Subscription | null = null
  private statusSub: Subscription | null = null
  private statusPaneKey = ''
  private debounce: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  private lastJson = ''
  private stopped = false

  private readonly socketPath: string

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  start(): void {
    this.stopped = false
    this.connect()
    this.poll = setInterval(() => void this.refresh(), POLL_MS)
  }

  stop(): void {
    this.stopped = true
    this.lifecycle?.close()
    this.statusSub?.close()
    for (const t of [this.debounce, this.retry]) if (t) clearTimeout(t)
    if (this.poll) clearInterval(this.poll)
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Ask for a fresh snapshot soon; bursts of events collapse into one request. */
  invalidate(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.refresh(), DEBOUNCE_MS)
  }

  private connect(): void {
    if (this.stopped) return
    this.lifecycle = subscribe(
      this.socketPath,
      LIFECYCLE_EVENTS.map((type) => ({ type })),
      {
        onReady: () => void this.refresh(),
        onEvent: () => this.invalidate(),
        onClose: (err) => {
          this.lifecycle = null
          if (this.stopped) return
          this.setState({ online: false, error: err?.message ?? 'herdr connection closed' })
          this.scheduleReconnect()
        },
      },
    )
  }

  private scheduleReconnect(): void {
    if (this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, RETRY_MS)
  }

  private async refresh(): Promise<void> {
    if (!this.lifecycle) return
    try {
      const result = await rpc<{ snapshot: Snapshot }>(this.socketPath, 'session.snapshot')
      this.setState({ online: true, snapshot: result.snapshot })
      this.syncStatusSubscription(result.snapshot)
    } catch (err) {
      this.setState({ online: false, error: (err as Error).message })
    }
  }

  private syncStatusSubscription(snapshot: Snapshot): void {
    const ids = snapshot.panes.map((p) => p.pane_id).sort()
    const key = ids.join(',')
    if (key === this.statusPaneKey && this.statusSub) return
    this.statusPaneKey = key
    this.statusSub?.close()
    this.statusSub = null
    if (ids.length === 0) return
    const sub = subscribe(
      this.socketPath,
      ids.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
      {
        onEvent: () => this.invalidate(),
        onClose: () => {
          // Rebuilt on the next refresh if it dropped while still wanted.
          if (this.statusSub === sub) {
            this.statusSub = null
            this.statusPaneKey = ''
          }
        },
      },
    )
    this.statusSub = sub
  }

  private setState(state: HubState): void {
    const json = JSON.stringify(state)
    if (json === this.lastJson) return
    this.lastJson = json
    this.state = state
    for (const l of this.listeners) l(state)
  }
}
