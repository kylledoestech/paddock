// Turns herdr agent state changes into phone notifications.
//   blocked            -> "claude · api needs you" + the question on screen
//   working -> done    -> "claude · api finished"
//   agent/pane gone    -> "claude in api exited"
// Quiet for a pane while a phone is viewing it (it holds a control session).
// One notifier per machine; with several machines, titles say which one.
import { rpc } from './herdr.ts'
import type { HubState } from './hub.ts'
import type { Machine } from './machines.ts'
import { sendPush, type PushKind } from './push.ts'
import { isViewing } from './terminal.ts'

// A state must hold this long before it notifies; filters detection flicker between tool calls.
const BLOCKED_SETTLE_MS = 1500
const DONE_SETTLE_MS = 4000
const QUESTION_MAX = 140

interface PaneLike {
  pane_id: string
  workspace_id: string
  agent?: string
  agent_status: string
  terminal_title_stripped?: string
}

interface Seen {
  agent?: string
  status: string
  workspace: string
}

// Box-drawing borders anywhere, and a leading cursor/bullet glyph.
const clean = (line: string) =>
  line.replace(/[│┃╭╮╰╯─━┌┐└┘╌]/g, ' ').replace(/^\s*[❯›●•◐✻⎿]\s*/, '').replace(/\s+/g, ' ').trim()
const isFooter = (line: string) => /\b(esc to|enter to|tab to|ctrl\+|↑\/↓|shift\+tab)\b/i.test(line)

// Menu entries Claude adds to every question; not real answers.
const GENERIC_OPTION = /^(type something|chat about this|other)\.?$/i

/**
 * What an agent is waiting on, from the bottom of its screen: the last line ending in `?`,
 * else the numbered options when the question itself scrolled out of view.
 */
export function extractQuestion(screen: string): string | null {
  const all = screen.split('\n').map(clean)
  const lines = all.filter((l) => l && !isFooter(l))
  // A question wraps on narrow panes: rejoin the lines of its paragraph above the `?` line.
  const end = all.findLastIndex((l) => l.endsWith('?') && !isFooter(l))
  let question: string | undefined
  if (end >= 0) {
    let start = end
    while (start > 0 && all[start - 1] && !/^\d+\.\s/.test(all[start - 1]) && !isFooter(all[start - 1])) start--
    question = all.slice(start, end + 1).join(' ')
  }
  const options = lines
    .map((l) => l.match(/^\d+\.\s+(.+)$/)?.[1])
    .filter((o): o is string => !!o && !GENERIC_OPTION.test(o))
  const text = question ?? (options.length ? `Choose: ${options.join(' · ')}` : null)
  return text && text.length > QUESTION_MAX ? `${text.slice(0, QUESTION_MAX - 1)}…` : text
}

export function startNotifier(machine: Machine, severalMachines: () => boolean): () => void {
  const hub = machine.hub
  let seen = new Map<string, Seen>()
  const timers = new Map<string, NodeJS.Timeout>()

  const panes = (state: HubState): PaneLike[] => (state.online ? (state.snapshot.panes as unknown as PaneLike[]) : [])
  const workspaceLabel = (state: HubState, id: string) => {
    if (!state.online) return id
    const workspaces = (state.snapshot.workspaces ?? []) as { workspace_id: string; label: string }[]
    return workspaces.find((w) => w.workspace_id === id)?.label ?? id
  }
  const current = (paneId: string) => panes(hub.state).find((p) => p.pane_id === paneId)

  const cancel = (key: string) => {
    clearTimeout(timers.get(key))
    timers.delete(key)
  }

  const notify = (kind: PushKind, paneId: string, title: string, body: string) => {
    const where = `${machine.id}/${paneId}`
    if (isViewing(machine.id, paneId)) return console.log(`[orca] ${kind} ${where}: quiet (open on a phone)`)
    console.log(`[orca] ${kind} ${where}: ${title} — ${body}`)
    void sendPush({
      kind,
      title,
      body,
      tag: `pane:${where}`,
      url: `/#/m/${encodeURIComponent(machine.id)}/pane/${encodeURIComponent(paneId)}`,
    })
  }
  const on = () => (severalMachines() ? ` on ${machine.label}` : '')

  /** Runs `fire` after `delay` unless the pane has left the state by then. */
  const settle = (paneId: string, kind: PushKind, delay: number, stillValid: (p: PaneLike) => boolean, fire: (p: PaneLike) => void) => {
    const key = `${paneId}:${kind}`
    cancel(key)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        const pane = current(paneId)
        if (pane && stillValid(pane)) fire(pane)
      }, delay),
    )
  }

  return hub.onChange((state) => {
    // Offline blips are not exits; compare again once herdr is back.
    if (!state.online) return
    const next = new Map<string, Seen>()

    for (const pane of panes(state)) {
      const workspace = workspaceLabel(state, pane.workspace_id)
      next.set(pane.pane_id, { agent: pane.agent, status: pane.agent_status, workspace })
      const before = seen.get(pane.pane_id)
      if (!pane.agent || !before) continue
      const who = `${pane.agent} · ${workspace}`

      if (pane.agent_status === 'blocked' && before.status !== 'blocked') {
        settle(pane.pane_id, 'blocked', BLOCKED_SETTLE_MS, (p) => p.agent_status === 'blocked', async (p) => {
          const read = await rpc<{ read: { text: string } }>(machine.socketPath, 'pane.read', {
            pane_id: p.pane_id,
            source: 'detection',
            format: 'text',
          }).catch(() => null)
          notify('blocked', p.pane_id, `${who}${on()} needs you`, (read && extractQuestion(read.read.text)) ?? 'Waiting for your input')
        })
      }

      if (pane.agent_status === 'working') cancel(`${pane.pane_id}:done`)
      else if (before.status === 'working' && (pane.agent_status === 'done' || pane.agent_status === 'idle')) {
        settle(pane.pane_id, 'done', DONE_SETTLE_MS, (p) => p.agent_status === 'done' || p.agent_status === 'idle', (p) =>
          notify('done', p.pane_id, `${who}${on()} finished`, p.terminal_title_stripped || 'Ready for your next message'),
        )
      }
    }

    for (const [paneId, before] of seen) {
      if (!before.agent) continue
      const now = next.get(paneId)
      if (now?.agent) continue
      cancel(`${paneId}:blocked`)
      cancel(`${paneId}:done`)
      notify('exited', paneId, `${before.agent} in ${before.workspace}${on()} exited`, now ? 'The pane is back at a shell' : 'The pane was closed')
    }

    seen = next
  })
}
