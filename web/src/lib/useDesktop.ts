import { useEffect, useState } from 'react'

// Wide screens get the sidebar + terminal layout; phones keep the single column.
const QUERY = '(min-width: 1024px)'

export function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const onChange = () => setDesktop(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return desktop
}
