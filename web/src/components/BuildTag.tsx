import { useEffect, useState } from 'react'
import { onPageResume } from '../data/live'

const CHECK_MS = 5 * 60_000

/** The newest build on the server, or null if it can't be read. version.json is never cached. */
async function latestBuild(): Promise<string | null> {
  const res = await fetch('/version.json', { cache: 'no-store' }).catch(() => null)
  if (!res?.ok) return null
  return ((await res.json().catch(() => ({}))) as { build?: string }).build ?? null
}

/**
 * Footer on the home screen: which build is running, and whether a newer one is on the server.
 * Checked on load, when the app comes back to the foreground, and every few minutes.
 */
export function BuildTag() {
  const [latest, setLatest] = useState<string | null>(null)

  useEffect(() => {
    const check = () => void latestBuild().then(setLatest)
    check()
    const timer = window.setInterval(check, CHECK_MS)
    const stopResume = onPageResume(check)
    return () => {
      window.clearInterval(timer)
      stopResume()
    }
  }, [])

  const outdated = latest !== null && latest !== __ORCA_BUILD__
  return (
    <div className="build-tag">
      <span>Orca · build {__ORCA_BUILD__}</span>
      {outdated ? (
        <button className="build-tag__update" onClick={() => window.location.reload()}>
          Update to {latest} — tap to reload
        </button>
      ) : (
        latest !== null && <span className="build-tag__ok">latest</span>
      )}
    </div>
  )
}
