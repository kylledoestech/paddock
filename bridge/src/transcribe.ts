// Speech to text for the phone's mic key: the phone records audio, the bridge sends it to Groq's
// hosted Whisper (whisper-large-v3: the full model; turbo trades accuracy for speed) and returns the text.
// The API key stays on this machine: GROQ_API_KEY, or ~/.config/orca/groq.key (mode 600).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from './http.ts'

const KEY_FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orca', 'groq.key')
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'
const MODEL = 'whisper-large-v3'
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // Groq's limit for direct uploads
// Whisper takes a short prompt to bias spelling toward names it would otherwise miss. Keep it short:
// long word lists push it toward those words even when you didn't say them.
const BASE_VOCABULARY = 'Claude, herdr, Orca'

const AUDIO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
}

async function apiKey(): Promise<string | null> {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim()
  const fromFile = await readFile(KEY_FILE, 'utf8').catch(() => '')
  return fromFile.trim() || null
}

export async function transcriptionConfigured(): Promise<boolean> {
  return (await apiKey()) !== null
}

/** Transcribes one recording. `hint` (e.g. the project and pane title) improves spelling of names. */
export async function transcribe(audio: Buffer, mime: string | undefined, hint: string, language: string | null): Promise<string> {
  const key = await apiKey()
  if (!key) throw new HttpError(503, `voice needs a Groq API key in ${KEY_FILE}`)
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase()
  const ext = AUDIO_EXT[type]
  if (!ext) throw new HttpError(415, `unsupported audio type: ${type || 'unknown'}`)
  if (audio.length < 1000) throw new HttpError(400, 'recording too short')

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type }), `speech.${ext}`)
  form.append('model', MODEL)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  form.append('prompt', [hint, BASE_VOCABULARY].filter(Boolean).join(', ').slice(0, 200))
  if (language) form.append('language', language)

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error) => {
    throw new HttpError(502, `speech service unreachable: ${err.message}`)
  })
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } }
  if (!res.ok) {
    const status = res.status === 401 ? 503 : 502
    throw new HttpError(status, res.status === 401 ? 'Groq rejected the API key' : `transcription failed: ${data.error?.message ?? res.status}`)
  }
  return (data.text ?? '').trim()
}
