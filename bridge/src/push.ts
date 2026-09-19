// Web Push to the user's phones. VAPID keys and subscriptions live in ~/.config/orca/.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import webpush, { type PushSubscription } from 'web-push'

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orca')
const KEYS_FILE = join(CONFIG_DIR, 'vapid.json')
const SUBS_FILE = join(CONFIG_DIR, 'push-subscriptions.json')

export type PushKind = 'blocked' | 'done' | 'exited'
export type PushPrefs = Record<PushKind, boolean>

export interface PushPayload {
  title: string
  body: string
  /** Same tag replaces the previous notification (one per pane). */
  tag: string
  url: string
  kind: PushKind | 'test'
}

interface StoredSubscription {
  subscription: PushSubscription
  prefs: PushPrefs
  createdAt: number
}

const DEFAULT_PREFS: PushPrefs = { blocked: true, done: true, exited: true }

let publicKey = ''
let subscriptions: StoredSubscription[] = []

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

const saveSubscriptions = () => writeFile(SUBS_FILE, JSON.stringify(subscriptions, null, 1), { mode: 0o600 })

/** Loads (or creates once) the VAPID keys and the saved subscriptions. */
export async function initPush(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  let keys = await readJson<{ publicKey: string; privateKey: string }>(KEYS_FILE)
  if (!keys) {
    keys = webpush.generateVAPIDKeys()
    await writeFile(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 })
  }
  // The subject is only a contact hint for push services; nothing is sent there.
  webpush.setVapidDetails('mailto:orca@localhost', keys.publicKey, keys.privateKey)
  publicKey = keys.publicKey
  subscriptions = (await readJson<StoredSubscription[]>(SUBS_FILE)) ?? []
}

export const vapidPublicKey = () => publicKey

function parsePrefs(value: unknown): PushPrefs {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<Record<PushKind, unknown>>
  return {
    blocked: input.blocked !== false,
    done: input.done !== false,
    exited: input.exited !== false,
  }
}

function parseSubscription(value: unknown): PushSubscription {
  const sub = value as PushSubscription | null
  const endpoint = sub?.endpoint
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') {
    throw Object.assign(new Error('invalid push subscription'), { status: 400 })
  }
  return { endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }
}

/** Adds or updates a phone's subscription (keyed by endpoint). */
export async function subscribe(rawSubscription: unknown, rawPrefs: unknown): Promise<void> {
  const subscription = parseSubscription(rawSubscription)
  const prefs = parsePrefs(rawPrefs ?? DEFAULT_PREFS)
  const existing = subscriptions.find((s) => s.subscription.endpoint === subscription.endpoint)
  if (existing) Object.assign(existing, { subscription, prefs })
  else subscriptions.push({ subscription, prefs, createdAt: Date.now() })
  await saveSubscriptions()
}

export async function unsubscribe(endpoint: unknown): Promise<void> {
  subscriptions = subscriptions.filter((s) => s.subscription.endpoint !== endpoint)
  await saveSubscriptions()
}

/** Sends to every subscription that wants this kind; drops subscriptions the push service says are gone. */
export async function sendPush(payload: PushPayload, onlyEndpoint?: string): Promise<number> {
  const targets = subscriptions.filter((s) =>
    onlyEndpoint ? s.subscription.endpoint === onlyEndpoint : payload.kind === 'test' || s.prefs[payload.kind],
  )
  const gone: string[] = []
  let delivered = 0
  await Promise.all(
    targets.map(async (s) => {
      try {
        // Urgency high: phones deliver immediately instead of batching until they wake.
        await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' })
        delivered++
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) gone.push(s.subscription.endpoint)
        else console.warn(`[orca] push failed (${status ?? 'network'}): ${(err as Error).message}`)
      }
    }),
  )
  if (gone.length) {
    subscriptions = subscriptions.filter((s) => !gone.includes(s.subscription.endpoint))
    await saveSubscriptions()
  }
  return delivered
}
