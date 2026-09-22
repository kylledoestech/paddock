import { useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import { MicKey } from './MicKey'
import { AttachImage, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, KeyEnter, KeyEsc, KeyInterrupt, KeyTab, Plus, Send } from './icons'

// Raw bytes sent to the pane through the control session (`terminal.input`).
interface Key {
  label: string
  seq: string
  Icon: ComponentType<{ size?: number }>
}
const ESC: Key = { label: 'esc', seq: '\x1b', Icon: KeyEsc }
const TAB: Key = { label: 'tab', seq: '\t', Icon: KeyTab }
const STOP: Key = { label: 'stop', seq: '\x03', Icon: KeyInterrupt }
const UP: Key = { label: 'up', seq: '\x1b[A', Icon: ChevronUp }
const DOWN: Key = { label: 'down', seq: '\x1b[B', Icon: ChevronDown }
const LEFT: Key = { label: 'left', seq: '\x1b[D', Icon: ChevronLeft }
const RIGHT: Key = { label: 'right', seq: '\x1b[C', Icon: ChevronRight }
const ENTER: Key = { label: 'enter', seq: '\r', Icon: KeyEnter }

/**
 * The terminal's control bar ("minimal + keys popover"): a message field, the hold-to-talk mic
 * (which becomes send once there is text) and a + that opens a grid with photo, Claude's mode
 * and the terminal keys. Phone keyboards type into the field, never into xterm directly.
 */
export function ControlBar({
  onInput,
  onPaste,
  onImage,
  uploading,
  modeTile,
  voiceHint,
}: {
  /** Raw key sequences to the pane. */
  onInput: (seq: string) => void
  /** Text to the pane as one bracketed paste (not submitted). */
  onPaste: (text: string) => void
  onImage: (file: File) => void
  uploading: boolean
  /** Claude's mode tile, only for Claude panes. */
  modeTile?: ReactNode
  /** Names that help speech recognition spell the project right. */
  voiceHint: string
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const send = () => {
    if (text) onPaste(text)
    // A short gap so the pane has taken the paste before Enter arrives.
    window.setTimeout(() => onInput('\r'), text ? 40 : 0)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Backspace' && text === '') {
      // Empty field: fix the pane's own prompt instead.
      e.preventDefault()
      onInput('\x7f')
    }
  }

  const key = ({ label, seq, Icon }: Key, wide = false) => (
    <button
      key={label}
      className={`cbar__tile${wide ? ' cbar__tile--wide' : ''}`}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onInput(seq)}
    >
      <Icon size={20} />
      <span>{label}</span>
    </button>
  )

  return (
    <div className="cbar">
      {open && (
        <>
          <button className="cbar__scrim" aria-label="Close keys" onClick={() => setOpen(false)} />
          <div className="cbar__pop" role="group" aria-label="Keys and actions">
            <button
              className="cbar__tile"
              disabled={uploading}
              onClick={() => {
                setOpen(false)
                fileRef.current?.click()
              }}
            >
              {uploading ? <span className="spinner" aria-hidden="true" /> : <AttachImage size={20} />}
              <span>photo</span>
            </button>
            {modeTile ?? key(TAB)}
            {key(STOP)}
            {key(ESC)}
            {key(UP)}
            {modeTile ? key(TAB) : key(ENTER)}
            {key(LEFT)}
            {key(DOWN)}
            {key(RIGHT)}
            {modeTile && key(ENTER, true)}
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // Allow picking the same photo again.
          if (file) onImage(file)
        }}
      />
      <div className="cbar__row">
        <textarea
          ref={inputRef}
          className="cbar__input"
          rows={1}
          value={text}
          placeholder="Type a message…"
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message the pane"
        />
        {text ? (
          <button className="cbar__round cbar__round--primary" aria-label="Send" onMouseDown={(e) => e.preventDefault()} onClick={send}>
            <Send size={20} />
          </button>
        ) : (
          <MicKey
            hint={voiceHint}
            // Dictation lands in the field so it can be fixed before sending.
            onText={(spoken) => {
              setText((current) => (current ? `${current} ${spoken}` : spoken))
              inputRef.current?.focus()
            }}
          />
        )}
        <button
          className="cbar__round"
          aria-label={open ? 'Close keys' : 'Keys, photo and mode'}
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
        >
          <Plus size={20} className={open ? 'cbar__plus--open' : undefined} />
        </button>
      </div>
    </div>
  )
}
