import { useEffect, useRef, useState, type ReactNode } from 'react'
import { pct } from '../lib/format'

/** A figure in the app's one number style (the same plain VT323 digits as "Shares out"). `big` is the hero size. */
export function Num({ value, big, className = '' }: { value: string; big?: boolean; className?: string }) {
  return <span className={`num ${big ? 'big' : ''} ${className}`}>{value}</span>
}

/** Flashes green/red briefly when `value` moves up/down. */
export function Flash({ value, children, as: Tag = 'span', className = '' }: { value: number | undefined; children: ReactNode; as?: 'span' | 'td' | 'div'; className?: string }) {
  const prev = useRef(value)
  const [state, setState] = useState<{ dir: '' | 'flash-up' | 'flash-down'; n: number }>({ dir: '', n: 0 })
  useEffect(() => {
    const p = prev.current
    prev.current = value
    if (p === undefined || value === undefined || p === value) return
    setState((s) => ({ dir: value > p ? 'flash-up' : 'flash-down', n: s.n + 1 }))
  }, [value])
  return <Tag key={state.n} className={`${className} ${state.dir}`}>{children}</Tag>
}

export function Change({ v }: { v: number | undefined }) {
  if (v === undefined || !Number.isFinite(v)) return <span className="chg flat">—</span>
  // Unchanged counts as up, so every badge is green or red.
  const up = v > -0.005
  return <span className={`chg ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {pct(up ? Math.abs(v) : v)}</span>
}

/** Amount input in the app's number style; accepts digits and a single dot, limited to `decimals`. */
export function AmountInput({ value, onChange, unit, decimals = 6, bad, id }: { value: string; onChange: (v: string) => void; unit: string; decimals?: number; bad?: boolean; id?: string }) {
  return (
    <div className={`field ${bad ? 'bad' : ''}`}>
      <div className="num-wrap">
        <input
          id={id}
          className="num-input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          onChange={(e) => {
            const v = e.target.value.replace(',', '.')
            if (v === '' || new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`).test(v)) onChange(v)
          }}
        />
      </div>
      <span className="unit">{unit}</span>
    </div>
  )
}

export function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return <div className="kv"><span>{k}</span><b>{children}</b></div>
}

export function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}
