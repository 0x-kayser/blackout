/** Small shared UI pieces: bars, sparklines, segmented controls, stat rows. */
import type { ReactNode } from 'react'

export function Bar({ value, max, tone = 'teal', label }: { value: number; max: number; tone?: string; label?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="bar" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <i className={`bar-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Spark({ values, height = 36, tone = 'teal', marker }: { values: number[]; height?: number; tone?: string; marker?: number }) {
  if (values.length < 2) return <div className="spark empty" style={{ height }} />
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const w = 100
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${height - ((v - min) / (max - min || 1)) * (height - 4) - 2}`).join(' ')
  return (
    <svg className={`spark ${tone}`} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden>
      <polyline points={pts} fill="none" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      {marker !== undefined && <line x1="0" x2={w} y1={height - ((marker - min) / (max - min || 1)) * (height - 4) - 2} y2={height - ((marker - min) / (max - min || 1)) * (height - 4) - 2} className="spark-marker" vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

export function Seg<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} title={o.hint} disabled={disabled} onClick={() => value !== o.value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Stat({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  )
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="sec">
      <header>
        <h4>{title}</h4>
        {aside}
      </header>
      {children}
    </section>
  )
}
