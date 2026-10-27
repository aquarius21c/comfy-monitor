import { expect, test } from 'claude-code/testing'

import { sparkline, svgChart } from '../hooks/chart'
import { parseNvidiaSmi, parseQueue, parseSystemStats, shortDevice, statusLine, toSample } from '../hooks/comfy'

import { SYSTEM_STATS } from './fixtures'

const GB = 1024 ** 3

test('reads VRAM, RAM, version and device from /system_stats', async () => {
  const stats = parseSystemStats(SYSTEM_STATS)
  expect(stats.version).toBe('0.39.2')
  expect(stats.device).toBe('RTX 5080')
  const sample = toSample(0, stats, { running: 1, pending: 2 }, null)
  expect(sample.vramUsed).toBe(10)
  expect(sample.vramTotal).toBe(16)
  expect(sample.ramUsed).toBe(24)
  expect(sample.gpu).toBe(null)
})

test('counts running and pending jobs from /queue', async () => {
  expect(parseQueue('{"queue_running":[[1,"a"]],"queue_pending":[[2,"b"],[3,"c"]]}')).toEqual({ running: 1, pending: 2 })
  expect(parseQueue('{}')).toEqual({ running: 0, pending: 0 })
})

test('reads nvidia-smi csv, and nothing from empty output', async () => {
  expect(parseNvidiaSmi('87, 64, 301.25\r\n')).toEqual({ gpu: 87, temp: 64, power: 301.25 })
  expect(parseNvidiaSmi('')).toBe(null)
  expect(parseNvidiaSmi('[N/A], 50, 20')).toBe(null)
})

test('shortens device names', async () => {
  expect(shortDevice('cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync')).toBe('RTX 4090')
  expect(shortDevice('cpu')).toBe('cpu')
})

test('status line shows queue, VRAM and GPU, or off', async () => {
  const sample = toSample(0, parseSystemStats(SYSTEM_STATS), { running: 1, pending: 2 }, { gpu: 87.4, temp: 60, power: 300 })
  expect(statusLine(sample, true)).toBe('Comfy ● ON · Run 1 · Wait 2 · VRAM 10.0/16G · GPU 87%')
  expect(statusLine(sample, false)).toBe('Comfy ○ OFF')
})

test('sparkline scales to max and keeps the newest values', async () => {
  expect(sparkline([0, 8, 16], 16, 10)).toBe('▁▅█')
  expect(sparkline([0, 1, 2, 3], 3, 2)).toBe('▆█')
})

test('svg chart escapes text and draws one line per series', async () => {
  const svg = svgChart({
    series: [{ values: [1, 2, 3], color: '#f00' }, { values: [0, 1], color: '#0f0' }],
    max: 4,
    capacity: 10,
    label: 'A<B',
    value: '3 GB',
  })
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.includes('A&lt;B')).toBe(true)
  expect(svg.split('<polyline').length - 1).toBe(2)
})
