import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { onPageResume, wsUrl } from '../data/live'

interface Frame {
  type: 'terminal.frame'
  seq: number
  bytes: string
  full: boolean
  width: number
  height: number
}

interface Closed {
  type: 'terminal.closed'
  code: number | null
  message: string
}

// Terminal font size: pinch to change, one size for every pane, remembered on this device.
const FONT_DEFAULT = 13
const FONT_MIN = 4
const FONT_MAX = 28
const FONT_KEY = 'paddock.termFontSize'

const clampFont = (n: number) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)))

function loadFontSize(): number {
  try {
    const saved = Number(localStorage.getItem(FONT_KEY))
    return saved ? clampFont(saved) : FONT_DEFAULT
  } catch {
    return FONT_DEFAULT
  }
}

function saveFontSize(size: number): void {
  try {
    localStorage.setItem(FONT_KEY, String(size))
  } catch {
    // Private mode: the size lasts for this visit only.
  }
}
const FONT_FAMILY = "'JetBrains Mono', ui-monospace, monospace"
const RESIZE_DEBOUNCE_MS = 150

function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Cell size in CSS px. xterm exposes it only internally; fall back to measuring the font. */
function cellSize(term: Terminal, fontSize: number): { width: number; height: number } {
  const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })
    ._core?._renderService?.dimensions?.css?.cell
  if (dims && dims.width > 0 && dims.height > 0) return dims
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = `${fontSize}px ${FONT_FAMILY}`
  return { width: ctx.measureText('M'.repeat(20)).width / 20, height: Math.ceil(fontSize * 1.2) }
}

/** What the terminal screen exposes to the rest of the terminal page. */
export interface TerminalControls {
  /** Sends raw text (keystrokes, escape sequences, bracketed pastes) to the controlled pane. */
  input: (text: string) => void
  /** Image file paths currently visible on screen, newest (lowest) first. */
  imagePaths: () => string[]
  /** Puts the keyboard focus in the terminal (desktop: type straight into the pane). */
  focus: () => void
}

// Absolute, ~/ or relative paths ending in an image extension, as agents and shells print them.
const IMAGE_PATH = /(?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.(?:png|jpe?g|webp|gif|svg|mp4|m4v|mov|webm)\b/gi

function imagePathsIn(text: string): { path: string; index: number }[] {
  return [...text.matchAll(IMAGE_PATH)].map((m) => ({ path: m[0], index: m.index ?? 0 }))
}

// Only http(s): a terminal prints all kinds of text, and other schemes can act on this device.
const URL_TEXT = /\bhttps?:\/\/[^\s"'`<>\\^{}|]+/gi
// Trailing punctuation usually belongs to the sentence, not the link: "see https://x.dev/docs."
const TRAILING = /[.,;:!?]+$/

function urlsIn(text: string): { url: string; index: number }[] {
  return [...text.matchAll(URL_TEXT)].map((m) => {
    let url = m[0].replace(TRAILING, '')
    // Keep a closing bracket the link itself opened, as in Wikipedia's /wiki/Shell_(computing);
    // drop one it never opened, as in Markdown "(https://x.dev)".
    while (/[)\]]$/.test(url)) {
      const close = url.slice(-1)
      const open = close === ')' ? '(' : '['
      const opens = url.split(open).length - 1
      const closes = url.split(close).length - 1
      if (closes <= opens) break
      url = url.slice(0, -1)
    }
    return { url, index: m.index ?? 0 }
  })
}

/**
 * Writable pane session sized to the phone. The bridge runs `herdr terminal session control`
 * at this component's size in cells, so herdr reflows the pane to fit instead of us scaling
 * a desktop-sized screen down. Leaving the screen releases control and the desktop size returns.
 *
 * Memoised: the parent re-renders on every herdr state update, which must not touch xterm.
 */
export const LiveTerminal = memo(function LiveTerminal({
  machineId,
  paneId,
  controlsRef,
  onImagePathRef,
  autoFocus = false,
}: {
  machineId: string
  paneId: string
  controlsRef: MutableRefObject<TerminalControls | null>
  /** Desktop: focus the terminal once it opens, so typing goes straight to the pane. */
  autoFocus?: boolean
  /** Called when an image path in the output is tapped. A ref, so the memoised terminal never re-renders. */
  onImagePathRef: MutableRefObject<(path: string) => void>
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatusState] = useState<string | null>('Connecting…')
  const [zoomLabel, setZoomLabel] = useState<string | null>(null)

  useEffect(() => {
    const box = boxRef.current
    const host = hostRef.current
    if (!box || !host) return

    let disposed = false
    // Frames arrive many times a second; only re-render React when the overlay text changes.
    let shownStatus: string | null = 'Connecting…'
    const setStatus = (next: string | null) => {
      if (next === shownStatus) return
      shownStatus = next
      setStatusState(next)
    }
    let ws: WebSocket | null = null
    let retry: number | undefined
    let resizeTimer: number | undefined
    let lastSeq = 0
    let ended = false
    let fontSize = loadFontSize()

    const term = new Terminal({
      cursorBlink: false,
      fontFamily: FONT_FAMILY,
      fontSize,
      lineHeight: 1,
      scrollback: 0,
      theme: { background: '#0a0b0c', foreground: '#cfccc5', cursor: '#cfccc5' },
    })

    const send = (msg: object) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    const dataSub = term.onData((text) => send({ type: 'input', text }))
    // Desktop terminal shortcuts. xterm would turn Ctrl+V into a literal ^V; handing it back lets the
    // browser paste instead (text through xterm's bracketed paste, images through the upload in
    // Terminal.tsx). Copy follows Windows Terminal: Ctrl+C copies only while text is selected.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'v') return false
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === '=' || key === '+' || key === '-' || key === '0')) {
        e.preventDefault()
        applyFontSize(key === '0' ? FONT_DEFAULT : clampFont(fontSize + (key === '-' ? -1 : 1)))
        return false
      }
      if (key === 'c' && ((e.ctrlKey && e.shiftKey) || e.metaKey || (e.ctrlKey && term.hasSelection()))) {
        if (term.hasSelection()) {
          void navigator.clipboard?.writeText(term.getSelection())
          term.clearSelection()
          e.preventDefault()
        }
        return false
      }
      return true
    })

    const lineText = (y: number) => term.buffer.active.getLine(y)?.translateToString(true) ?? ''
    // herdr repaints the pane row by row, so xterm's own isWrapped flag is never set. A row that
    // fills the width is treated as continuing into the next one, which is how a long path looks.
    const runsOn = (y: number) => y >= 0 && lineText(y).trimEnd().length >= term.cols
    const startsRun = (y: number) => !runsOn(y - 1)

    /** A row plus the rows its text ran onto, so a path split by the width stays one string. */
    const wrappedText = (y: number): string => {
      let text = lineText(y).trimEnd()
      for (let next = y; runsOn(next) && next + 1 < term.buffer.active.length; next++) text += lineText(next + 1).trimEnd()
      return text
    }

    controlsRef.current = {
      input: (text) => send({ type: 'input', text }),
      imagePaths: () => {
        const found: string[] = []
        for (let y = term.buffer.active.length - 1; y >= 0; y--) {
          if (!startsRun(y)) continue // Covered by the row its text started on.
          for (const { path } of imagePathsIn(wrappedText(y))) if (!found.includes(path)) found.push(path)
        }
        return found
      },
      focus: () => term.focus(),
    }

    // Tappable links in the output: http(s) URLs open in a new tab, image and video paths open in
    // the viewer. Both handle text that wrapped across rows.
    const linkSub = term.registerLinkProvider({
      provideLinks(y, callback) {
        if (!startsRun(y - 1)) return callback(undefined)
        const text = wrappedText(y - 1)
        const cols = term.cols
        const cell = (index: number) => ({ x: (index % cols) + 1, y: y + Math.floor(index / cols) })
        const urls = urlsIn(text)
        const urlLinks = urls.map(({ url, index }) => ({
          range: { start: cell(index), end: cell(index + url.length - 1) },
          text: url,
          activate: () => window.open(url, '_blank', 'noopener,noreferrer'),
        }))
        // A path inside a URL (https://host/chart.png) belongs to the URL.
        const inUrl = (index: number) => urls.some((u) => index >= u.index && index < u.index + u.url.length)
        const pathLinks = imagePathsIn(text)
          .filter(({ index }) => !inUrl(index))
          .map(({ path, index }) => ({
            range: { start: cell(index), end: cell(index + path.length - 1) },
            text: path,
            activate: () => onImagePathRef.current(path),
          }))
        const links = [...urlLinks, ...pathLinks]
        callback(links.length ? links : undefined)
      },
    })

    /** Cols and rows that fit the box; `scale` estimates them for a font size not applied yet. */
    const fitCells = (scale = 1) => {
      const cell = cellSize(term, fontSize)
      return {
        cols: Math.max(20, Math.floor(box.clientWidth / (cell.width * scale))),
        rows: Math.max(5, Math.floor(box.clientHeight / (cell.height * scale))),
      }
    }

    /** Detaches and closes the socket; closing makes the bridge release control of the pane. */
    const drop = () => {
      window.clearTimeout(retry)
      if (!ws) return
      ws.onmessage = ws.onclose = null
      ws.close()
      ws = null
    }

    const connect = () => {
      drop()
      const { cols, rows } = fitCells()
      term.resize(cols, rows)
      lastSeq = 0
      ws = new WebSocket(wsUrl(`/ws/term?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}&cols=${cols}&rows=${rows}`))
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as Frame | Closed
        if (msg.type === 'terminal.closed') {
          ended = true
          setStatus(msg.message || 'Session ended')
          return
        }
        if (term.cols !== msg.width || term.rows !== msg.height) term.resize(msg.width, msg.height)
        // herdr repaints with `full` frames every few seconds even when idle. Reset only on
        // the first frame or after a gap; otherwise write it like any other frame.
        if (lastSeq === 0 || msg.seq !== lastSeq + 1) term.reset()
        lastSeq = msg.seq
        term.write(decode(msg.bytes))
        setStatus(null)
      }
      ws.onclose = () => {
        if (disposed || ended) return
        setStatus('Reconnecting…')
        retry = window.setTimeout(connect, 1000)
      }
    }

    // Leaving the app hands the pane back to the desktop (its size returns); coming back
    // takes control again at once instead of waiting on a socket the phone may have frozen.
    const onHidden = () => {
      if (document.visibilityState !== 'hidden' || disposed || ended) return
      drop()
      setStatus('Paused while Paddock is in the background')
    }
    document.addEventListener('visibilitychange', onHidden)
    const stopResume = onPageResume(() => {
      if (disposed || ended || ws?.readyState === WebSocket.OPEN) return
      setStatus('Reconnecting…')
      connect()
    })

    // Keyboard opening/closing and rotation change the box; tell herdr the new size.
    const onBoxResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        const { cols, rows } = fitCells()
        if (cols === term.cols && rows === term.rows) return
        term.resize(cols, rows)
        send({ type: 'resize', cols, rows })
      }, RESIZE_DEBOUNCE_MS)
    }
    const resizeObserver = new ResizeObserver(onBoxResize)

    const applyFontSize = (target: number) => {
      if (target === fontSize) return
      fontSize = target
      saveFontSize(fontSize)
      term.options.fontSize = fontSize
      // herdr reflows the pane to the new size, like a rotation or keyboard resize.
      const { cols, rows } = fitCells()
      term.resize(cols, rows)
      send({ type: 'resize', cols, rows })
    }

    // One finger drags herdr's scrollback for the pane (xterm here keeps none of its own).
    // Two fingers pinch the font size: previewed as a CSS scale, applied when the fingers lift.
    let touchY: number | null = null
    let touchAcc = 0
    let pinch: { startDistance: number; scale: number } | null = null
    const distance = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const pinchTarget = () => clampFont(fontSize * (pinch?.scale ?? 1))

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        touchY = null
        pinch = { startDistance: distance(e.touches), scale: 1 }
        const rect = host.getBoundingClientRect()
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
        host.style.transformOrigin = `${midX}px ${midY}px`
        return
      }
      touchY = e.touches[0]?.clientY ?? null
      touchAcc = 0
    }
    const onTouchMove = (e: TouchEvent) => {
      if (pinch && e.touches.length >= 2) {
        // Limit the preview to what the font range allows, so it lands where it shows.
        const raw = distance(e.touches) / pinch.startDistance
        pinch.scale = Math.max(FONT_MIN / fontSize, Math.min(FONT_MAX / fontSize, raw))
        host.style.transform = `scale(${pinch.scale})`
        const target = pinchTarget()
        const { cols, rows } = fitCells(target / fontSize)
        setZoomLabel(`${target}px · ${cols}×${rows}`)
        return
      }
      const y = e.touches[0]?.clientY
      if (touchY === null || y === undefined) return
      touchAcc += y - touchY
      touchY = y
      const lineHeight = cellSize(term, fontSize).height
      const lines = Math.trunc(touchAcc / lineHeight)
      if (lines !== 0) {
        touchAcc -= lines * lineHeight
        send({ type: 'scroll', direction: lines > 0 ? 'up' : 'down', lines: Math.abs(lines) })
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        const target = pinchTarget()
        pinch = null
        host.style.transform = ''
        setZoomLabel(null)
        applyFontSize(target)
      }
      if (e.touches.length === 0) touchY = null
    }

    // Desktop: the wheel scrolls herdr's scrollback like the one-finger drag, unless the program
    // in the pane asked for mouse events (vim, htop…), which xterm then sends itself.
    // Ctrl+wheel changes the font size like the pinch, instead of zooming the whole page.
    let wheelAcc = 0
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        if (e.deltaY !== 0) applyFontSize(clampFont(fontSize + (e.deltaY < 0 ? 1 : -1)))
        return
      }
      if (term.modes.mouseTrackingMode !== 'none') return
      e.preventDefault()
      e.stopPropagation()
      const lineHeight = cellSize(term, fontSize).height
      wheelAcc += e.deltaMode === 1 ? e.deltaY * lineHeight : e.deltaMode === 2 ? e.deltaY * term.rows * lineHeight : e.deltaY
      const lines = Math.trunc(wheelAcc / lineHeight)
      if (lines !== 0) {
        wheelAcc -= lines * lineHeight
        send({ type: 'scroll', direction: lines < 0 ? 'up' : 'down', lines: Math.abs(lines) })
      }
    }

    // Measure with the real font, not a fallback, before sizing the pane.
    void document.fonts.load(`${fontSize}px "JetBrains Mono"`).finally(() => {
      if (disposed) return
      term.open(host)
      // GPU renderer: the DOM renderer repaints whole rows as DOM nodes and crawls on phones.
      // Falls back to DOM automatically if WebGL is unavailable or the context is lost.
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // No WebGL: keep the DOM renderer.
      }
      // Phone keyboards type into the Composer instead: their whole-word compositions break
      // xterm's hidden textarea. inputmode=none keeps the on-screen keyboard from opening here;
      // a hardware keyboard still types straight into the terminal.
      const textarea = host.querySelector('textarea')
      if (textarea) {
        textarea.setAttribute('inputmode', 'none')
        textarea.setAttribute('autocomplete', 'off')
        textarea.setAttribute('autocorrect', 'off')
        textarea.setAttribute('autocapitalize', 'off')
        textarea.setAttribute('spellcheck', 'false')
      }
      if (autoFocus) term.focus()
      resizeObserver.observe(box)
      host.addEventListener('touchstart', onTouchStart, { passive: true })
      host.addEventListener('touchmove', onTouchMove, { passive: true })
      host.addEventListener('touchend', onTouchEnd, { passive: true })
      host.addEventListener('touchcancel', onTouchEnd, { passive: true })
      // Capture phase, so this runs before xterm's own wheel handling.
      host.addEventListener('wheel', onWheel, { passive: false, capture: true })
      connect()
    })

    return () => {
      disposed = true
      controlsRef.current = null
      linkSub.dispose()
      document.removeEventListener('visibilitychange', onHidden)
      stopResume()
      drop()
      window.clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      host.removeEventListener('wheel', onWheel, { capture: true })
      host.removeEventListener('touchcancel', onTouchEnd)
      dataSub.dispose()
      term.dispose()
    }
  }, [machineId, paneId, controlsRef, onImagePathRef])

  return (
    <div ref={boxRef} className="live-term">
      <div ref={hostRef} className="live-term__host" />
      {status && <div className="live-term__status">{status}</div>}
      {zoomLabel && (
        <div className="live-term__zoom" aria-live="polite">
          {zoomLabel}
        </div>
      )}
    </div>
  )
})
