import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyRoot } from './auth/PrivyRoot'
import './styles.css'

// The regional power game is the product; the original city game stays playable at /city.
const RegionApp = lazy(() => import('./region/RegionApp'))
const CityApp = lazy(() => import('./App'))
const city = location.pathname.startsWith('/city')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrivyRoot>
      <Suspense fallback={<div className="region-boot"><h1>BLACKOUT</h1></div>}>{city ? <CityApp /> : <RegionApp />}</Suspense>
    </PrivyRoot>
  </StrictMode>,
)
