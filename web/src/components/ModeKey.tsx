import { useCallback, useEffect, useState, type ComponentType } from 'react'
import type { ClaudeMode } from '../data/live'
import { useStore } from '../data/store'
import { ActionSheet } from './ActionSheet'
import { ModeAcceptEdits, ModeAuto, ModeBypass, ModeManual, ModePlan } from './icons'

const MODES: { mode: ClaudeMode; label: string; desc: string; Icon: ComponentType<{ size?: number }> }[] = [
  { mode: 'manual', label: 'Manual', desc: 'Ask before edits and commands', Icon: ModeManual },
  { mode: 'acceptEdits', label: 'Accept edits', desc: 'Edit files without asking', Icon: ModeAcceptEdits },
  { mode: 'plan', label: 'Plan', desc: 'Research and plan, no changes', Icon: ModePlan },
  { mode: 'auto', label: 'Auto', desc: 'Decide on its own (not every model)', Icon: ModeAuto },
]

const labelOf = (mode: ClaudeMode | null) =>
  mode === 'bypass' ? 'Bypass' : (MODES.find((m) => m.mode === mode)?.label ?? 'Mode')

/**
 * Control-bar tile showing Claude's permission mode (icon + name). Tap to pick one; the bridge
 * presses Shift+Tab until Claude shows it. Re-read whenever the agent's state changes.
 */
export function ModeKey({ paneId, agentStatus }: { paneId: string; agentStatus: string }) {
  const { api, notify } = useStore()
  const [mode, setMode] = useState<ClaudeMode | null>(null)
  const [picking, setPicking] = useState(false)
  const [switching, setSwitching] = useState(false)

  const refresh = useCallback(() => {
    api.getMode(paneId).then(setMode, () => setMode(null))
  }, [api, paneId])

  useEffect(refresh, [refresh, agentStatus])

  const pick = async (target: ClaudeMode) => {
    setPicking(false)
    if (target === mode) return
    setSwitching(true)
    try {
      setMode(await api.setMode(paneId, target))
    } catch (err) {
      notify('error', `Mode not changed: ${(err as Error).message}`)
      refresh()
    } finally {
      setSwitching(false)
    }
  }

  const Current = (mode && MODES.find((m) => m.mode === mode)?.Icon) || (mode === 'bypass' ? ModeBypass : ModeManual)

  return (
    <>
      <button
        className="cbar__tile cbar__tile--mode"
        aria-haspopup="dialog"
        aria-label={`Claude mode: ${labelOf(mode)}`}
        disabled={switching}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPicking(true)}
      >
        {switching ? <span className="spinner" aria-hidden="true" /> : <Current size={20} />}
        <span>{switching ? 'switching' : labelOf(mode).toLowerCase()}</span>
      </button>
      {picking && (
        <ActionSheet
          title="Claude mode"
          onClose={() => setPicking(false)}
          actions={MODES.map(({ mode: m, label, desc, Icon }) => ({
            title: m === mode ? `${label} · current` : label,
            desc,
            Icon,
            onSelect: () => void pick(m),
          }))}
        />
      )}
    </>
  )
}
