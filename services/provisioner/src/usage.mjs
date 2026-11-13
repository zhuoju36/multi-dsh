/** Usage reporting helpers. Quota months are UTC. */

/**
 * Resolve a `YYYY-MM` month (or the current UTC month) to [since, until).
 * @param {string | undefined} month
 * @param {Date} [now]
 * @returns {{since: Date, until: Date}}
 */
export function monthRange(month, now = new Date()) {
  let year = now.getUTCFullYear()
  let monthIndex = now.getUTCMonth()
  if (month !== undefined && month !== '') {
    const match = /^(\d{4})-(\d{2})$/.exec(month)
    if (!match) throw new Error('--month must be YYYY-MM')
    year = Number(match[1])
    monthIndex = Number(match[2]) - 1
    if (monthIndex < 0 || monthIndex > 11) throw new Error('--month must be YYYY-MM')
  }
  return {
    since: new Date(Date.UTC(year, monthIndex, 1)),
    until: new Date(Date.UTC(year, monthIndex + 1, 1)),
  }
}
