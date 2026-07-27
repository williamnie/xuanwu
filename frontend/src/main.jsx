import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installChunkLoadRecovery } from './chunkLoadRecovery.js'
import { I18nProvider } from './i18n/I18nProvider.jsx'

installChunkLoadRecovery()
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
