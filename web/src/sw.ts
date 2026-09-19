/// <reference lib="webworker" />
// Orca's service worker: offline shell (precache) and push notifications for agent events.
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope

interface PushPayload {
  title: string
  body: string
  tag: string
  url: string
  kind: string
}

precacheAndRoute(self.__WB_MANIFEST)
// App navigations get the cached shell; live herdr state (/api, /ws) always goes to the network.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/ws/] }))

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  const data = (event.data?.json() ?? {}) as Partial<PushPayload>
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Orca', {
      body: data.body,
      tag: data.tag,
      // Re-alert when a newer event replaces the pane's previous notification.
      renotify: Boolean(data.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url ?? '/' },
    } as NotificationOptions),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data as { url?: string })?.url ?? '/', self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (existing) {
        await existing.focus().catch(() => undefined)
        // Orca routes with the #hash, and Chrome often ignores navigate() when only the hash
        // changes, so the open app is told where to go instead (App.tsx handles 'orca:open').
        existing.postMessage({ type: 'orca:open', url })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
