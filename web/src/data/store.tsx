import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import type { Machine } from '../types/herdr'
import { mockMachines } from '../mock/snapshot'
import { apiFor, connectLive, type BridgeState, type LinkStatus, type MachineApi, type MachineInfo, type Notice } from './live'

// `VITE_MOCK=1 npm run dev` runs the UI on fake data without a bridge.
const MOCK = import.meta.env.VITE_MOCK === '1'

interface State {
  machines: Machine[]
  machineId: string
  /** Phone ↔ bridge link. While reconnecting, the last snapshot stays on screen. */
  link: LinkStatus
  /** False until the bridge's first state message arrives. */
  connected: boolean
  showShells: boolean
  collapsed: string[]
  notices: Notice[]
}

type Action =
  | { type: 'selectMachine'; id: string }
  | { type: 'toggleShells' }
  | { type: 'toggleWorkspace'; key: string }
  | { type: 'machines'; list: MachineInfo[] }
  | { type: 'bridgeState'; machine: MachineInfo; state: BridgeState }
  | { type: 'link'; status: LinkStatus }
  | { type: 'notice'; level: Notice['level']; message: string }
  | { type: 'dismissNotice'; id: number }

const COLLAPSED_KEY = 'orca.collapsed'
const MACHINE_KEY = 'orca.machine'
let noticeId = 0

function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function loadMachineId(): string | null {
  try {
    return localStorage.getItem(MACHINE_KEY)
  } catch {
    return null
  }
}

const fromInfo = (info: MachineInfo, snapshot: Machine['snapshot']): Machine => ({
  ...info,
  online: info.status === 'online' && !!snapshot,
  snapshot: info.status === 'online' ? snapshot : null,
})

/** Keeps the chosen machine if it still exists, else the remembered one, else the first. */
function pickMachine(machines: Machine[], current: string): string {
  if (machines.some((m) => m.id === current)) return current
  const remembered = loadMachineId()
  return machines.find((m) => m.id === remembered)?.id ?? machines[0]?.id ?? current
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'selectMachine':
      return { ...state, machineId: action.id }
    case 'machines': {
      const machines = action.list.map((info) =>
        fromInfo(info, state.machines.find((m) => m.id === info.id)?.snapshot ?? null),
      )
      return { ...state, machines, machineId: pickMachine(machines, state.machineId) }
    }
    case 'toggleShells':
      return { ...state, showShells: !state.showShells }
    case 'toggleWorkspace': {
      const has = state.collapsed.includes(action.key)
      return {
        ...state,
        collapsed: has ? state.collapsed.filter((k) => k !== action.key) : [...state.collapsed, action.key],
      }
    }
    case 'bridgeState': {
      const machine = fromInfo(action.machine, action.state.online ? action.state.snapshot : null)
      const exists = state.machines.some((m) => m.id === machine.id)
      const machines = exists
        ? state.machines.map((m) => (m.id === machine.id ? machine : m))
        : [...state.machines.filter((m) => m.id !== placeholderMachine.id), machine]
      return { ...state, connected: true, machines, machineId: pickMachine(machines, state.machineId) }
    }
    case 'link':
      return { ...state, link: action.status }
    case 'notice':
      return { ...state, notices: [...state.notices, { id: ++noticeId, level: action.level, message: action.message }] }
    case 'dismissNotice':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) }
  }
}

interface Store extends State {
  machine: Machine
  /** Actions bound to the selected machine. */
  api: MachineApi
  dispatch: (action: Action) => void
  notify: (level: Notice['level'], message: string) => void
}

const StoreContext = createContext<Store | null>(null)

const placeholderMachine: Machine = {
  id: 'this-machine',
  label: 'connecting…',
  kind: 'local',
  online: false,
  status: 'offline',
  snapshot: null,
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    machines: MOCK ? mockMachines : [placeholderMachine],
    machineId: MOCK ? mockMachines[0].id : placeholderMachine.id,
    link: (MOCK ? 'open' : 'connecting') as LinkStatus,
    connected: MOCK,
    showShells: false,
    collapsed: loadCollapsed(),
    notices: [],
  }))

  useEffect(() => {
    if (MOCK) return
    return connectLive({
      onMachines: (list) => dispatch({ type: 'machines', list }),
      onState: (machine, bridgeState) => dispatch({ type: 'bridgeState', machine, state: bridgeState }),
      onNotice: (level, message) => dispatch({ type: 'notice', level, message }),
      onLink: (status) => dispatch({ type: 'link', status }),
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state.collapsed))
    } catch {
      // Storage unavailable (private mode); collapse state stays in memory.
    }
  }, [state.collapsed])

  // Remember the chosen machine for the next visit.
  useEffect(() => {
    if (state.machineId === placeholderMachine.id) return
    try {
      localStorage.setItem(MACHINE_KEY, state.machineId)
    } catch {
      // Private mode: the choice lasts for this visit only.
    }
  }, [state.machineId])

  const notify = useCallback((level: Notice['level'], message: string) => dispatch({ type: 'notice', level, message }), [])
  const machine = state.machines.find((m) => m.id === state.machineId) ?? state.machines[0]
  const api = useMemo(() => apiFor(machine.id), [machine.id])
  return <StoreContext.Provider value={{ ...state, machine, api, dispatch, notify }}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore outside StoreProvider')
  return store
}

/** Collapse keys are scoped per machine so identical workspace ids don't collide. */
export const collapseKey = (machineId: string, workspaceId: string) => `${machineId}/${workspaceId}`
