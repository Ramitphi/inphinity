// Tiny path router. Uses history.pushState so installShareSync() mirrors the path to Studio.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '')
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
window.addEventListener('popstate', emit)

export const currentPath = () => {
  const p = window.location.pathname
  const rel = BASE && p.startsWith(BASE) ? p.slice(BASE.length) : p
  return rel || '/'
}

export function navigate(path: string) {
  if (path === currentPath()) return
  window.history.pushState(null, '', BASE + path)
  window.scrollTo(0, 0)
  emit()
}

/** Replaces the current history entry (for redirects from old routes). Keeps the query string. */
export function redirect(path: string) {
  window.history.replaceState(null, '', BASE + path + window.location.search)
  emit()
}

export const usePath = () =>
  useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), currentPath)

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={BASE + to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e)
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
      {...rest}
    />
  )
}
