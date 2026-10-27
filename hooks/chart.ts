const BARS = '▁▂▃▄▅▆▇█'

/** The last `width` values as a one-line block chart scaled to 0..max. */
export function sparkline(values: readonly number[], max: number, width: number): string {
  const tail = values.slice(-Math.max(1, width))
  const top = max > 0 ? max : Math.max(1, ...tail)

  return tail
    .map(value => {
      const ratio = Math.min(1, Math.max(0, value / top))
      return BARS[Math.min(BARS.length - 1, Math.round(ratio * (BARS.length - 1)))]
    })
    .join('')
}

export type Series = { values: readonly number[]; color: string }

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A small line chart: one or more series over the same 0..max scale, newest at
 * the right, with the label top-left and the current value top-right.
 */
export function svgChart(input: {
  series: readonly Series[]
  max: number
  capacity: number
  label: string
  value: string
  width?: number
  height?: number
  isStep?: boolean
}): string {
  const width = input.width ?? 320
  const height = input.height ?? 72
  const top = 20
  const bottom = height - 4
  const max = input.max > 0 ? input.max : 1
  const step = width / Math.max(1, input.capacity - 1)

  const lines = input.series
    .map(({ values, color }) => {
      const tail = values.slice(-input.capacity)
      if (tail.length === 0) return ''
      const offset = input.capacity - tail.length
      const points: string[] = []
      tail.forEach((value, i) => {
        const x = (offset + i) * step
        const y = bottom - (Math.min(max, Math.max(0, value)) / max) * (bottom - top)
        if (input.isStep && i > 0) points.push(`${x.toFixed(1)},${points[points.length - 1]?.split(',')[1]}`)
        points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
      })
      const first = points[0]?.split(',')[0] ?? '0'
      const last = points[points.length - 1]?.split(',')[0] ?? '0'
      const area = `${first},${bottom} ${points.join(' ')} ${last},${bottom}`

      return (
        `<polygon points="${area}" fill="${color}" fill-opacity="0.15"/>` +
        `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`
      )
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<line x1="0" y1="${bottom}" x2="${width}" y2="${bottom}" stroke="#8884" stroke-width="1"/>` +
    `<line x1="0" y1="${top}" x2="${width}" y2="${top}" stroke="#8882" stroke-width="1" stroke-dasharray="3 3"/>` +
    lines +
    `<text x="0" y="12" font-family="system-ui, sans-serif" font-size="11" fill="#888">${escapeXml(input.label)}</text>` +
    `<text x="${width}" y="12" font-family="system-ui, sans-serif" font-size="11" fill="#888" text-anchor="end">${escapeXml(input.value)}</text>` +
    `</svg>`
  )
}
