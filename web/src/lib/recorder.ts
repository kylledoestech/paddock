// Records the phone mic for the hold-to-talk key and gets the text back from the bridge
// (Groq Whisper). The mic stream stays open briefly after a recording so the next hold starts
// instantly, then closes so the phone's mic indicator goes away.

const KEEP_MIC_OPEN_MS = 60_000
const MIN_RECORDING_MS = 500
// Below this the recording is only a container header: Android sometimes delivers no audio frames.
const MIN_AUDIO_BYTES = 4000

let stream: MediaStream | null = null
let closeTimer: number | undefined

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

export const recordingSupported = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

async function microphone(): Promise<MediaStream> {
  window.clearTimeout(closeTimer)
  if (stream?.active) return stream
  try {
    // Whisper copes with background noise itself; the phone's noise suppression and echo
    // cancellation smear consonants and cost accuracy. Gain control keeps quiet speech usable.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    })
  } catch (err) {
    const name = (err as DOMException).name
    throw new Error(
      name === 'NotAllowedError'
        ? 'Microphone blocked — allow it in the site settings'
        : name === 'NotFoundError'
          ? 'No microphone found'
          : `Microphone unavailable (${name})`,
    )
  }
  return stream
}

function releaseMicLater(): void {
  window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }, KEEP_MIC_OPEN_MS)
}

export interface Recording {
  /** 0–1 input level, for the live meter. */
  level(): number
  /** Stops and resolves with the audio, or null when the hold was too short to be speech. */
  stop(): Promise<Blob | null>
}

export async function startRecording(): Promise<Recording> {
  const mic = await microphone()
  const mime = pickMime()
  // 128 kbps Opus: clearer consonants than the ~32 kbps default, still small (~16 KB/s).
  const recorder = new MediaRecorder(mic, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 128_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const startedAt = performance.now()
  // Ask for data every 250 ms: some Android builds lose everything but the header when the
  // whole recording is flushed only at stop().
  recorder.start(250)

  // Level meter from the same stream.
  const audio = new AudioContext()
  const analyser = audio.createAnalyser()
  analyser.fftSize = 512
  audio.createMediaStreamSource(mic).connect(analyser)
  const samples = new Uint8Array(analyser.fftSize)

  return {
    level() {
      analyser.getByteTimeDomainData(samples)
      let peak = 0
      for (const s of samples) peak = Math.max(peak, Math.abs(s - 128))
      return Math.min(1, peak / 64)
    },
    stop() {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          void audio.close()
          releaseMicLater()
          const long = performance.now() - startedAt >= MIN_RECORDING_MS
          const clip = new Blob(chunks, { type: recorder.mimeType || mime })
          resolve(long && clip.size >= MIN_AUDIO_BYTES ? clip : null)
        }
        recorder.stop()
      })
    },
  }
}

export async function transcriptionReady(): Promise<boolean> {
  const res = await fetch('/api/transcribe').catch(() => null)
  return !!res?.ok && ((await res.json()) as { configured: boolean }).configured
}

/** Sends audio to the bridge; `hint` (project, pane title) helps Whisper spell names right. */
export async function transcribeAudio(audio: Blob, hint: string): Promise<string> {
  // No language hint: Whisper detects it per clip, so Taglish isn't forced through English.
  const params = new URLSearchParams({ hint })
  const res = await fetch(`/api/transcribe?${params}`, {
    method: 'POST',
    headers: { 'content-type': audio.type.split(';')[0] },
    body: audio,
  })
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data.text ?? ''
}
