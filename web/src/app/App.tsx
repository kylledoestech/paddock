import { useEffect, useState } from 'react'
import { Home } from '../screens/Home'
import { Terminal } from '../screens/Terminal'
import { Notices } from '../components/Notices'
import { useStore } from '../data/store'
import { useDesktop } from '../lib/useDesktop'

// Hash routes: `#/` home, `#/m/<machine>/pane/<pane_id>` terminal (ids URI-encoded; pane ids
// contain ':'). The older `#/pane/<pane_id>` still opens a pane on the selected machine.
interface Route {
  machineId: string | null
  paneId: string | null
}

function parseHash(): Route {
  const hash = window.location.hash
  const withMachine = hash.match(/^#\/m\/([^/]+)\/pane\/(.+)$/)
  if (withMachine) return { machineId: decodeURIComponent(withMachine[1]), paneId: decodeURIComponent(withMachine[2]) }
  const legacy = hash.match(/^#\/pane\/(.+)$/)
  return { machineId: null, paneId: legacy ? decodeURIComponent(legacy[1]) : null }
}

export function App() {
  const { machine, machines, dispatch } = useStore()
  const desktop = useDesktop()
  const [route, setRoute] = useState(parseHash)

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // A tapped notification (service worker) tells the already-open app which pane to show.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null
      if (data?.type !== 'orca:open' || !data.url) return
      const target = new URL(data.url, location.origin)
      if (target.origin !== location.origin) return
      if (location.hash !== target.hash) location.hash = target.hash
      else setRoute(parseHash())
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  // A link to another machine's pane (e.g. from a notification) switches to that machine.
  useEffect(() => {
    if (route.machineId && route.machineId !== machine.id && machines.some((m) => m.id === route.machineId)) {
      dispatch({ type: 'selectMachine', id: route.machineId })
    }
  }, [route.machineId, machine.id, machines, dispatch])

  const openPane = (paneId: string, machineId = machine.id) => {
    window.location.hash = `/m/${encodeURIComponent(machineId)}/pane/${encodeURIComponent(paneId)}`
  }
  const goHome = () => {
    window.location.hash = '/'
  }

  const onRouteMachine = !route.machineId || route.machineId === machine.id
  const paneId = route.paneId && onRouteMachine ? route.paneId : null

  // Desktop: the home list is a sidebar and the chosen pane opens beside it.
  if (desktop) {
    return (
      <div className="desktop">
        <aside className="desktop__side">
          <Home sidebar activePaneId={paneId ?? undefined} onOpenPane={openPane} />
        </aside>
        <section className="desktop__main">
          {paneId ? (
            <Terminal key={`${machine.id}/${paneId}`} paneId={paneId} onBack={goHome} embedded />
          ) : (
            <div className="desktop__empty">
              <strong>Pick a pane</strong>
              <span>Choose an agent or shell on the left, or press ⌘K to search.</span>
            </div>
          )}
        </section>
        <Notices />
      </div>
    )
  }

  return (
    <>
      {route.paneId && onRouteMachine ? (
        <Terminal paneId={route.paneId} onBack={goHome} />
      ) : (
        <Home onOpenPane={openPane} />
      )}
      <Notices />
    </>
  )
}
