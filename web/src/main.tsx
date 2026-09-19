import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Latin subsets only: the full packages add Cyrillic/Greek/Vietnamese faces nobody here needs.
import '@fontsource/geist/latin-400.css'
import '@fontsource/geist/latin-500.css'
import '@fontsource/geist/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-700.css'
import './styles/tokens.css'
import './styles/base.css'
import { StoreProvider } from './data/store'
import { App } from './app/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
)
