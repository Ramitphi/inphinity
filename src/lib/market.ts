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
