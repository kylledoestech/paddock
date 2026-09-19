import { useState, type FormEvent } from 'react'
import { useStore } from '../data/store'
import { Sheet } from './Sheet'
import { Segmented } from './Segmented'
import { Branch, ChevronRight, Space, Sparkle, Terminal } from './icons'

const AGENTS = ['claude', 'codex', 'opencode', 'cursor'] as const
type AgentName = (typeof AGENTS)[number]
const agentOptions = AGENTS.map((a) => ({ value: a, label: a }))

type Step = 'choose' | 'agent' | 'terminal' | 'space' | 'worktree'

export function NewSheet({ onClose, onOpenPane }: { onClose: () => void; onOpenPane: (paneId: string) => void }) {
  const [step, setStep] = useState<Step>('choose')
  const back = () => setStep('choose')

  if (step === 'agent') {
    return (
      <Sheet title="New agent" onClose={onClose} onBack={back}>
        <NewAgentForm onDone={onClose} />
      </Sheet>
    )
  }
  if (step === 'terminal') {
    return (
      <Sheet title="New terminal" onClose={onClose} onBack={back}>
        <NewTerminalForm
          onOpened={(paneId) => {
            onClose()
            onOpenPane(paneId)
          }}
        />
      </Sheet>
    )
  }
  if (step === 'space') {
    return (
      <Sheet title="New space" onClose={onClose} onBack={back}>
        <NewSpaceForm onDone={onClose} />
      </Sheet>
    )
  }
  if (step === 'worktree') {
    return (
      <Sheet title="New worktree" onClose={onClose} onBack={back}>
        <NewWorktreeForm onDone={onClose} />
      </Sheet>
    )
  }
  return (
    <Sheet title="New" onClose={onClose}>
      <div className="choice-list">
        <button className="choice" onClick={() => setStep('agent')}>
          <Sparkle />
          <span className="choice__text">
            <span className="choice__title">New agent</span>
            <span className="choice__desc">Start an agent in a workspace</span>
          </span>
          <ChevronRight size={16} className="chevron" />
        </button>
        <button className="choice" onClick={() => setStep('terminal')}>
          <Terminal />
          <span className="choice__text">
            <span className="choice__title">New terminal</span>
            <span className="choice__desc">A plain shell in a new tab, no agent</span>
          </span>
          <ChevronRight size={16} className="chevron" />
        </button>
        <button className="choice" onClick={() => setStep('space')}>
          <Space />
          <span className="choice__text">
            <span className="choice__title">New space</span>
            <span className="choice__desc">A new workspace in a folder, optionally with an agent</span>
          </span>
          <ChevronRight size={16} className="chevron" />
        </button>
        <button className="choice" onClick={() => setStep('worktree')}>
          <Branch />
          <span className="choice__text">
            <span className="choice__title">New worktree</span>
            <span className="choice__desc">Branch + workspace + agent in one go</span>
          </span>
          <ChevronRight size={16} className="chevron" />
        </button>
      </div>
    </Sheet>
  )
}

function useWorkspaceOptions() {
  const { machine } = useStore()
  return (machine.snapshot?.workspaces ?? []).map((w) => ({ value: w.workspace_id, label: w.label }))
}

function NewAgentForm({ onDone }: { onDone: () => void }) {
  const { notify, api } = useStore()
  const workspaces = useWorkspaceOptions()
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.value ?? '')
  const [agent, setAgent] = useState<AgentName>('claude')
  const [prompt, setPrompt] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Bridge: new tab -> `agent.start` -> optional `agent.prompt`. Startup can take a while,
    // so the result arrives later as a notice.
    api.newAgent(workspaceId, agent, prompt).then(
      () => notify('info', `Starting ${agent}…`),
      (err: Error) => notify('error', `Could not start ${agent}: ${err.message}`),
    )
    onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Segmented label="Workspace" options={workspaces} value={workspaceId} onChange={setWorkspaceId} />
      <Segmented label="Agent" options={agentOptions} value={agent} onChange={setAgent} />
      <label className="field">
        <span className="field__label">Prompt (optional)</span>
        <textarea
          className="field__control"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should it work on?"
        />
      </label>
      <button className="primary-button" type="submit" disabled={!workspaceId}>
        Start {agent}
      </button>
    </form>
  )
}

function NewWorktreeForm({ onDone }: { onDone: () => void }) {
  const { notify, api } = useStore()
  const workspaces = useWorkspaceOptions()
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.value ?? '')
  const [branch, setBranch] = useState('')
  const [agent, setAgent] = useState<AgentName>('claude')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Bridge: `worktree.create`, then `agent.start` in its root pane.
    const name = branch.trim()
    api.newWorktree(workspaceId, name, agent).then(
      () => notify('info', `Creating ${name}…`),
      (err: Error) => notify('error', `Could not create ${name}: ${err.message}`),
    )
    onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Segmented label="From workspace" options={workspaces} value={workspaceId} onChange={setWorkspaceId} />
      <label className="field">
        <span className="field__label">Branch</span>
        <input
          className="field__control"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="feature/auth-sessions"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <Segmented label="Agent" options={agentOptions} value={agent} onChange={setAgent} />
      <button className="primary-button" type="submit" disabled={!workspaceId || !branch.trim()}>
        Create worktree
      </button>
    </form>
  )
}

const HOME_PREFIX = /^\/home\/[^/]+/

/** Folders already open in herdr (where agents actually run), plus home. */
function useKnownFolders(): string[] {
  const { machine } = useStore()
  const panes = machine.snapshot?.panes ?? []
  const folders = panes.map((p) => (p.foreground_cwd || p.cwd).replace(HOME_PREFIX, '~'))
  return [...new Set(['~', ...folders])].slice(0, 8)
}

const NO_AGENT = 'none'
const spaceAgentOptions = [{ value: NO_AGENT, label: 'none' }, ...agentOptions]

function NewSpaceForm({ onDone }: { onDone: () => void }) {
  const { notify, api } = useStore()
  const folders = useKnownFolders()
  const [folder, setFolder] = useState(folders[folders.length > 1 ? 1 : 0] ?? '~')
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<string>(NO_AGENT)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cwd = folder.trim()
    const label = name.trim() || cwd.split('/').filter(Boolean).pop() || '~'
    // Bridge: `workspace.create`, then `agent.start` in its first pane when an agent is picked.
    api.newWorkspace(cwd, name.trim(), agent === NO_AGENT ? null : agent).then(
      () => notify('info', `Creating space ${label}…`),
      (err: Error) => notify('error', `Could not create space: ${err.message}`),
    )
    onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span className="field__label">Folder</span>
        <input
          className="field__control"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="~/projects/app"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <div className="segmented" role="group" aria-label="Recent folders">
        {folders.map((f) => (
          <button key={f} type="button" className="segmented__item" aria-pressed={f === folder} onClick={() => setFolder(f)}>
            {f}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field__label">Name (optional)</span>
        <input
          className="field__control"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={folder.split('/').filter(Boolean).pop() || '~'}
          maxLength={60}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <Segmented label="Start an agent" options={spaceAgentOptions} value={agent} onChange={setAgent} />
      <button className="primary-button" type="submit" disabled={!folder.trim()}>
        Create space
      </button>
    </form>
  )
}

function NewTerminalForm({ onOpened }: { onOpened: (paneId: string) => void }) {
  const { notify, api } = useStore()
  const workspaces = useWorkspaceOptions()
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.value ?? '')
  const [name, setName] = useState('')
  const [opening, setOpening] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setOpening(true)
    try {
      // Bridge: `tab.create` gives a shell pane; open it straight away.
      onOpened(await api.newTerminal(workspaceId, name.trim()))
    } catch (err) {
      notify('error', `Could not open a terminal: ${(err as Error).message}`)
      setOpening(false)
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <Segmented label="Space" options={workspaces} value={workspaceId} onChange={setWorkspaceId} />
      <label className="field">
        <span className="field__label">Tab name (optional)</span>
        <input
          className="field__control"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="shell"
          maxLength={60}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <button className="primary-button" type="submit" disabled={!workspaceId || opening}>
        {opening ? 'Opening…' : 'Open terminal'}
      </button>
    </form>
  )
}
