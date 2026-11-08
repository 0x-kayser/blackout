import { useEffect, useRef } from 'react'
import type { EconomyEvent, GameStatePublic } from '@blackout/shared'
import { CityRenderer } from './renderer'

export function CityCanvas(props: {
  state: GameStatePublic | null
  selectedId?: string | null
  pendingBusinessId?: string | null
  highlightGenerators?: boolean
  reducedMotion?: boolean
  attract?: boolean
  onPick?: (id: string | null) => void
  subscribe?: (l: (e: EconomyEvent) => void) => () => void
  label?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const r = useRef<CityRenderer | null>(null)
  const fitted = useRef(false)

  useEffect(() => {
    if (!ref.current) return
    const renderer = new CityRenderer(ref.current)
    r.current = renderer
    if (import.meta.env.DEV) (window as unknown as { __city?: CityRenderer }).__city = renderer // dev diagnostics only
    renderer.start()
    return () => renderer.stop()
  }, [])

  useEffect(() => {
    const rr = r.current
    if (!rr) return
    rr.setView({
      state: props.state,
      selectedId: props.selectedId ?? null,
      pendingBusinessId: props.pendingBusinessId ?? null,
      highlightGenerators: !!props.highlightGenerators,
      reducedMotion: !!props.reducedMotion,
      attract: !!props.attract,
    })
    if (!fitted.current) {
      rr.fit()
      fitted.current = true
    }
  }, [props.state, props.selectedId, props.pendingBusinessId, props.highlightGenerators, props.reducedMotion, props.attract])

  const unlockedCount = props.state?.districts.filter((d) => d.unlocked).length ?? 1
  useEffect(() => {
    r.current?.fit()
  }, [unlockedCount])

  useEffect(() => {
    if (r.current) r.current.onPick = props.onPick ?? (() => {})
  }, [props.onPick])

  useEffect(() => {
    if (!props.subscribe) return
    return props.subscribe((e) => r.current?.pushEvent(e))
  }, [props.subscribe])

  return (
    <div className="city-wrap">
      <canvas ref={ref} className="city-canvas" role="img" aria-label={props.label ?? 'City map'} />
      {!props.attract && (
        <div className="zoom-controls">
          <button aria-label="Zoom in" onClick={() => r.current?.zoomBy(1.2)}>+</button>
          <button aria-label="Zoom out" onClick={() => r.current?.zoomBy(1 / 1.2)}>−</button>
          <button aria-label="Recentre" onClick={() => r.current?.fit()}>◎</button>
        </div>
      )}
    </div>
  )
}
