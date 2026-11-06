// NYSE regular session: 9:30–16:00 America/New_York, Monday to Friday (holidays not modelled).
export function nyseStatus(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false })
      .formatToParts(now).map((p) => [p.type, p.value]),
  )
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute)
  const weekday = !['Sat', 'Sun'].includes(parts.weekday)
  const open = weekday && minutes >= 9 * 60 + 30 && minutes < 16 * 60
  return { open, label: open ? 'NYSE OPEN' : 'NYSE CLOSED' }
}

export const masthead = (now = new Date()) =>
  now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()

/** Unix seconds of 9:30 America/New_York on the given NY calendar date (DST-aware). */
function nyOpenUtc(y: number, m: number, d: number) {
  for (const utcHour of [13, 14]) { // 9:30 EDT = 13:30 UTC, 9:30 EST = 14:30 UTC
    const t = Date.UTC(y, m - 1, d, utcHour, 30)
    const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(t)
    if (Number(h) % 24 === 9) return t / 1000
  }
  return Date.UTC(y, m - 1, d, 14, 30) / 1000
}

/**
 * Start of the most recent NYSE session that has already opened (weekdays, holidays not modelled).
 * The last price reported before this moment is treated as the previous close for daily change.
 */
export function lastSessionOpen(now = new Date()) {
  for (let back = 0; back < 7; back++) {
    const day = new Date(now.getTime() - back * 86_400_000)
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(day).map((x) => [x.type, x.value]),
    )
    if (['Sat', 'Sun'].includes(p.weekday)) continue
    const open = nyOpenUtc(Number(p.year), Number(p.month), Number(p.day))
    if (open <= now.getTime() / 1000) return open
  }
  return Math.floor(now.getTime() / 1000) - 86_400
}
