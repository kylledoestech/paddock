// Claude Code's permission mode, read from and switched on its screen. Claude cycles modes with
// Shift+Tab and shows the current one in its status line ("⏸ plan mode on", "⏵⏵ accept edits on").
// Switching presses Shift+Tab and re-reads until the requested mode shows, so it works whatever the
// cycle order is for the running model (auto mode is not offered by every model).
import { rpc } from './herdr.ts'
import { HttpError } from './http.ts'

export type ClaudeMode = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypass'

const PATTERNS: [ClaudeMode, RegExp][] = [
  ['acceptEdits', /accept edits on/i],
  ['plan', /plan mode on/i],
  ['auto', /auto mode on/i],
  ['bypass', /bypass permissions on/i],
  ['manual', /manual mode on/i],
]

export const MODES = new Set<ClaudeMode>(PATTERNS.map(([mode]) => mode))

const MAX_PRESSES = 6
const SETTLE_MS = 350

async function readMode(sock: string, paneId: string): Promise<ClaudeMode | null> {
  const read = await rpc<{ read: { text: string } }>(sock, 'pane.read', { pane_id: paneId, source: 'visible', lines: 6, format: 'text' })
  // Only the bottom lines hold the status line; earlier output could mention a mode name.
  const tail = read.read.text.split('\n').slice(-6).join('\n')
  return PATTERNS.find(([, re]) => re.test(tail))?.[0] ?? null
}

export const currentMode = readMode

/** Presses Shift+Tab until `target` shows; resolves to the mode reached. */
export async function switchMode(sock: string, paneId: string, target: ClaudeMode): Promise<ClaudeMode> {
  let mode = await readMode(sock, paneId)
  if (mode === null) throw new HttpError(409, 'can’t see Claude’s mode line — is Claude at its prompt?')
  const seen = new Set<ClaudeMode>([mode])
  for (let i = 0; i < MAX_PRESSES && mode !== target; i++) {
    await rpc(sock, 'pane.send_keys', { pane_id: paneId, keys: ['shift+tab'] })
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    mode = (await readMode(sock, paneId)) ?? mode
    // Back where we started without passing the target: this model doesn't offer it.
    if (mode !== target && seen.has(mode) && i > 0) break
    seen.add(mode)
  }
  if (mode !== target) throw new HttpError(409, `${target} mode isn’t available here (now in ${mode})`)
  return mode
}
