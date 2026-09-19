import { useEffect, useRef, useState } from 'react'
import { useStore } from '../data/store'
import { recordingSupported, startRecording, transcribeAudio, type Recording } from '../lib/recorder'
import { Mic } from './icons'

type Phase = 'idle' | 'listening' | 'transcribing'

// Whisper invents words for silence and noise ("Thank you."), so quiet recordings aren't sent.
const SPEECH_LEVEL = 0.12

/**
 * Hold to talk: records while the key is held, then Whisper (via the bridge) turns it into text
 * that is pasted into the pane's prompt, never submitted. A bubble shows elapsed time and level.
 */
export function MicKey({ hint, onText }: { hint: string; onText: (text: string) => void }) {
  const { notify } = useStore()
  const [phase, setPhase] = useState<Phase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const recording = useRef<Recording | null>(null)
  const starting = useRef<Promise<void> | null>(null)
  const released = useRef(false)
  const peak = useRef(0)

  // Live meter and timer while listening.
  useEffect(() => {
    if (phase !== 'listening') return
    const startedAt = performance.now()
    let frame = 0
    const tick = () => {
      setSeconds(Math.floor((performance.now() - startedAt) / 1000))
      const now = recording.current?.level() ?? 0
      peak.current = Math.max(peak.current, now)
      setLevel(now)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [phase])

  const finish = async () => {
    await starting.current
    const active = recording.current
    recording.current = null
    if (!active) return setPhase('idle')
    setPhase('transcribing')
    try {
      const audio = await active.stop()
      if (!audio) return notify('info', 'Recording too short — hold the mic while you speak')
      if (peak.current < SPEECH_LEVEL) return notify('info', 'Didn’t hear anything — hold and speak a little closer')
      const text = (await transcribeAudio(audio, hint)).trim()
      if (text) onText(text)
      else notify('info', 'Didn’t catch any words')
    } catch (err) {
      notify('error', `Voice: ${(err as Error).message}`)
    } finally {
      setPhase('idle')
    }
  }

  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (phase !== 'idle') return
    if (!recordingSupported()) return notify('error', 'This browser can’t record audio')
    e.currentTarget.setPointerCapture(e.pointerId)
    released.current = false
    peak.current = 0
    setPhase('listening')
    navigator.vibrate?.(10)
    starting.current = startRecording().then(
      (rec) => {
        recording.current = rec
      },
      (err: Error) => {
        notify('error', err.message)
        setPhase('idle')
      },
    )
    // A release that happened while the mic was still opening.
    void starting.current.then(() => released.current && void finish())
  }

  const onUp = () => {
    if (phase !== 'listening' || released.current) return
    released.current = true
    if (recording.current) void finish()
  }

  const busy = phase !== 'idle'
  return (
    <>
      <button
        className={`cbar__round cbar__round--primary cbar__mic${phase === 'listening' ? ' cbar__mic--recording' : ''}`}
        aria-label={phase === 'listening' ? 'Listening — release to insert' : 'Hold to talk'}
        aria-pressed={phase === 'listening'}
        aria-busy={phase === 'transcribing'}
        title="Hold to talk"
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {phase === 'transcribing' ? <span className="spinner" aria-hidden="true" /> : <Mic size={20} />}
      </button>
      {busy && (
        <div className="voice-bubble" role="status" aria-live="polite">
          {phase === 'listening' ? (
            <>
              <span className="voice-bubble__meter" aria-hidden="true">
                {[0.5, 0.8, 1, 0.8, 0.5].map((w, i) => (
                  <span key={i} style={{ transform: `scaleY(${0.15 + level * w})` }} />
                ))}
              </span>
              <span className="voice-bubble__text">
                Listening · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} — release to insert
              </span>
            </>
          ) : (
            <span className="voice-bubble__text">Transcribing…</span>
          )}
        </div>
      )}
    </>
  )
}
