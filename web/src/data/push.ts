// Phone side of push notifications: permission, subscription and per-event preferences.
export type PushKind = 'blocked' | 'done' | 'exited'
export type PushPrefs = Record<PushKind, boolean>
export type PushStatus = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on'

const PREFS_KEY = 'orca.pushPrefs'
export const DEFAULT_PREFS: PushPrefs = { blocked: true, done: true, exited: true }

export function loadPrefs(): PushPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PushPrefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

function savePrefs(prefs: PushPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Prefs still live on the bridge with the subscription.
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/** Push needs HTTPS, a service worker and the Push API (iOS only inside an installed app). */
export async function pushStatus(): Promise<PushStatus> {
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  return subscription && Notification.permission === 'granted' ? 'on' : 'off'
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Must run from a tap: asks permission, subscribes, registers with the bridge, sends a test. */
export async function enablePush(prefs: PushPrefs): Promise<void> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'blocked' : 'not allowed')
  const registration = await navigator.serviceWorker.ready
  const { key } = (await (await fetch('/api/push/key')).json()) as { key: string }
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }))
  await post('/api/push/subscribe', { subscription: subscription.toJSON(), prefs })
  savePrefs(prefs)
  await post('/api/push/test', { endpoint: subscription.endpoint })
}

export async function updatePrefs(prefs: PushPrefs): Promise<void> {
  savePrefs(prefs)
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  if (subscription) await post('/api/push/subscribe', { subscription: subscription.toJSON(), prefs })
}

export async function disablePush(): Promise<void> {
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  if (!subscription) return
  await post('/api/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => undefined)
  await subscription.unsubscribe()
}

export async function sendTest(): Promise<void> {
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  await post('/api/push/test', { endpoint: subscription?.endpoint })
}
