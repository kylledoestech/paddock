import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useStore } from '../data/store'
import { imageUrl, type MediaItem } from '../data/live'
import { isShell, paneTitle, tabFor, workspaceFor } from '../data/selectors'
import { prepareImage } from '../lib/resizeImage'
import { StatusDot } from '../components/StatusDot'
import { ControlBar } from '../components/ControlBar'
import { ModeKey } from '../components/ModeKey'
import { MediaSheet } from '../components/MediaSheet'
import { ImageViewer } from '../components/ImageViewer'
import { ActionSheet } from '../components/ActionSheet'
import { RenameSheet } from '../components/RenameSheet'
import { ConfirmSheet } from '../components/ConfirmSheet'
import type { TerminalControls } from '../components/LiveTerminal'
import { Back, ChevronDown, Media, Pencil, Trash } from '../components/icons'

// xterm + WebGL are most of the bundle; load them only when a terminal is opened.
const LiveTerminal = lazy(() => import('../components/LiveTerminal').then((m) => ({ default: m.LiveTerminal })))

// Bracketed paste: the agent's prompt treats it as pasted text (Claude Code attaches pasted image
// paths), and nothing is submitted, so the user can review or add to it before pressing enter.
const paste = (text: string, trailingSpace = true) => `\x1b[200~${text}${trailingSpace ? ' ' : ''}\x1b[201~`

/**
 * A message the user typed goes in as plain keystrokes. Sent as a bracketed paste it arrives as
 * "pasted text", which Claude Code deliberately does not take instructions from, so answers like
 * "yes, go ahead" were ignored. Multi-line text still pastes: the newlines would submit it early.
 */
const typed = (text: string) => (text.includes('\n') ? paste(text, false) : text)

export function Terminal({
  paneId,
  onBack,
  embedded = false,
}: {
  paneId: string
  onBack: () => void
  /** Desktop: shown beside the sidebar, so there is no back button. */
  embedded?: boolean
}) {
  const { machine, connected, notify, api } = useStore()
  const controlsRef = useRef<TerminalControls | null>(null)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [viewer, setViewer] = useState<{ items: MediaItem[]; index: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [names, setNames] = useState<'none' | 'actions' | 'rename-tab' | 'rename-space' | 'close-pane' | 'close-tab'>('none')
  // Read by the memoised terminal on tap; refreshed every render so it always targets this pane.
  const onImagePathRef = useRef<(path: string) => void>(() => undefined)
  onImagePathRef.current = (path) =>
    setViewer({ items: [{ name: path.split('/').pop() ?? path, path, mtime: Date.now(), url: imageUrl(machine.id, paneId, path) }], index: 0 })
  const attachImages = async (files: File[]) => {
    setUploading(true)
    try {
      // One at a time, so the paths land in the prompt in the order they were pasted.
      for (const file of files) {
        // Videos upload as they are; only photos go through the resizer.
        const body = file.type.startsWith('video/') ? file : await prepareImage(file)
        const path = await api.uploadImage(paneId, body)
        if (controlsRef.current) controlsRef.current.input(paste(path))
        else notify('info', `Image saved to ${path}`)
      }
      if (controlsRef.current) {
        const kind = files.every((f) => f.type.startsWith('video/')) ? 'Video' : 'Image'
        notify('info', files.length > 1 ? `${files.length} files attached — add a message and press enter` : `${kind} attached — add a message and press enter`)
      }
    } catch (err) {
      notify('error', `Upload failed: ${(err as Error).message}`)
    } finally {
      setUploading(false)
    }
  }
  const attachImagesRef = useRef(attachImages)
  attachImagesRef.current = attachImages

  // Pasting an image (Ctrl+V / Cmd+V) anywhere on this screen uploads it like the photo button.
  // Capture phase, so the terminal doesn't also receive the paste as (empty) text.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
      if (!images.length) return
      e.preventDefault()
      e.stopPropagation()
      void attachImagesRef.current(images)
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  }, [])

  const snapshot = machine.snapshot
  const pane = snapshot?.panes.find((p) => p.pane_id === paneId)

  if (!snapshot || !pane) {
    return (
      <div className="term">
        <div className="term__head">
          {!embedded && (
            <button className="icon-button" aria-label="Back" onClick={onBack}>
              <Back />
            </button>
          )}
          <span className="term__name">{connected ? 'Pane closed' : 'Connecting…'}</span>
        </div>
      </div>
    )
  }

  const shell = isShell(pane)
  const workspace = workspaceFor(snapshot, pane)
  const tab = tabFor(snapshot, pane)
  const where = `${workspace?.label}/${tab?.label}`

  return (
    <div className="term">
      <header className="term__head">
        {!embedded && (
          <button className="icon-button" aria-label="Back" onClick={onBack}>
            <Back />
          </button>
        )}
        <button className="term__heading" aria-haspopup="dialog" aria-label="Rename tab or space" onClick={() => setNames('actions')}>
          <span className="term__name">
            <StatusDot status={shell ? 'unknown' : pane.agent_status} small />
            <span className="ellipsis">{shell ? 'shell' : pane.agent} · {paneTitle(pane)}</span>
          </span>
          <span className="term__sub">
            <span className="ellipsis">
              {where} · {pane.pane_id}
            </span>
            <ChevronDown size={12} strokeWidth={2} />
          </span>
        </button>
        <button className="icon-button" aria-label="Images" aria-haspopup="dialog" onClick={() => setMediaOpen(true)}>
          <Media />
        </button>
      </header>
      <div className="term__screen">
        <Suspense fallback={<div className="live-term__status">Loading…</div>}>
          <LiveTerminal
            machineId={machine.id}
            paneId={pane.pane_id}
            controlsRef={controlsRef}
            onImagePathRef={onImagePathRef}
            autoFocus={embedded}
          />
        </Suspense>
      </div>
      {/* Desktop types straight into the terminal; the phone keyboard needs the message bar. */}
      {!embedded && (
        <ControlBar
          onInput={(seq) => controlsRef.current?.input(seq)}
          onPaste={(text) => controlsRef.current?.input(typed(text))}
          onImage={(file) => void attachImages([file])}
          uploading={uploading}
          modeTile={pane.agent === 'claude' ? <ModeKey paneId={pane.pane_id} agentStatus={pane.agent_status} /> : undefined}
          voiceHint={[workspace?.label, tab?.label, paneTitle(pane)].filter(Boolean).join(', ')}
        />
      )}
      {mediaOpen && (
        <MediaSheet
          paneId={pane.pane_id}
          screenPaths={controlsRef.current?.imagePaths() ?? []}
          onOpen={(items, index) => setViewer({ items, index })}
          onClose={() => setMediaOpen(false)}
        />
      )}
      {names === 'actions' && (
        <ActionSheet
          title={where}
          onClose={() => setNames('none')}
          actions={[
            ...(tab ? [{ title: 'Rename tab', desc: tab.label, Icon: Pencil, onSelect: () => setNames('rename-tab') }] : []),
            ...(workspace
              ? [{ title: 'Rename space', desc: workspace.label, Icon: Pencil, onSelect: () => setNames('rename-space') }]
              : []),
            ...(tab && tab.pane_count > 1
              ? [{ title: 'Close pane', desc: 'Just this pane; the tab stays', Icon: Trash, onSelect: () => setNames('close-pane') }]
              : []),
            ...(tab ? [{ title: 'Close tab', desc: tab.label, Icon: Trash, onSelect: () => setNames('close-tab') }] : []),
          ]}
        />
      )}
      {names === 'rename-tab' && tab && (
        <RenameSheet
          title="Rename tab"
          fieldLabel="Tab name"
          initial={tab.label}
          onSave={(label) => api.renameTab(tab.tab_id, label)}
          onBack={() => setNames('actions')}
          onClose={() => setNames('none')}
        />
      )}
      {names === 'rename-space' && workspace && (
        <RenameSheet
          title="Rename space"
          fieldLabel="Space name"
          initial={workspace.label}
          onSave={(label) => api.renameWorkspace(workspace.workspace_id, label)}
          onBack={() => setNames('actions')}
          onClose={() => setNames('none')}
        />
      )}
      {names === 'close-pane' && (
        <ConfirmSheet
          title="Close pane?"
          message={`Ends the ${shell ? 'shell' : pane.agent} running in this pane. This can’t be undone.`}
          confirmLabel="Close pane"
          onConfirm={() => api.closePane(pane.pane_id).then(onBack)}
          onBack={() => setNames('actions')}
          onClose={() => setNames('none')}
        />
      )}
      {names === 'close-tab' && tab && (
        <ConfirmSheet
          title="Close tab?"
          message={`Closes “${tab.label}” and ends ${
            tab.pane_count > 1 ? `everything in its ${tab.pane_count} panes` : `the ${shell ? 'shell' : pane.agent} running in it`
          }. This can’t be undone.`}
          confirmLabel="Close tab"
          onConfirm={() => api.closeTab(tab.tab_id).then(onBack)}
          onBack={() => setNames('actions')}
          onClose={() => setNames('none')}
        />
      )}
      {viewer && <ImageViewer items={viewer.items} start={viewer.index} onClose={() => setViewer(null)} />}
    </div>
  )
}
