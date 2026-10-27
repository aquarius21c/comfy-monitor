import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { jobLine, jobToast, parseHistory, parseQueue, parseSystemStats, progressBar, statusLine, toSample, vramHigh } from '../hooks/comfy'
import type { Sample } from '../types'

import { SYSTEM_STATS } from './fixtures'

const GB = 1024 ** 3

const HISTORY = JSON.stringify({
  a1: {
    status: {
      status_str: 'success',
      completed: true,
      messages: [
        ['execution_start', { prompt_id: 'a1', timestamp: 1_000 }],
        ['execution_cached', { nodes: [], timestamp: 1_001 }],
        ['execution_success', { prompt_id: 'a1', timestamp: 13_300 }],
      ],
    },
  },
  b2: {
    status: {
      status_str: 'error',
      completed: false,
      messages: [
        ['execution_start', { prompt_id: 'b2', timestamp: 20_000 }],
        ['execution_error', { prompt_id: 'b2', node_type: 'KSampler', exception_message: 'CUDA out of memory', timestamp: 25_000 }],
      ],
    },
  },
})

const sample = (t: number, usedGb: number): Sample => ({
  t, vramUsed: usedGb, vramTotal: 16, torchVram: 0, ramUsed: 1, ramTotal: 64, running: 1, pending: 0, gpu: null, temp: null, power: null,
})

const PANE = {
  component: 'Pane',
  requestId: 'comfy-monitor',
  props: { title: 'ComfyUI', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('reads finished jobs from /history, newest first, with run time and error', async () => {
  const jobs = parseHistory(HISTORY)
  expect(jobs.map(j => j.id)).toEqual(['b2', 'a1'])
  expect(jobs[1]).toEqual({ id: 'a1', result: 'success', endedAt: 13_300, durationMs: 12_300 })
  expect(jobs[0]?.result).toBe('error')
  expect(jobs[0]?.error).toBe('KSampler: CUDA out of memory')
  expect(jobToast(jobs[1]!)).toBe('ComfyUI 작업 완료 · 12.3초')
  expect(jobToast(jobs[0]!)).toBe('ComfyUI 작업 실패 · 5.0초 · KSampler: CUDA out of memory')
  expect(jobLine(jobs[1]!, 13_300 + 5 * 60_000)).toContain('5분 전')
})

test('names the running prompt nodes from /queue', async () => {
  const queue = parseQueue(JSON.stringify({
    queue_running: [[0, 'p1', { '3': { class_type: 'KSampler', inputs: {} } }, {}, []]],
    queue_pending: [],
  }))
  expect(queue.nodeTypes).toEqual({ '3': 'KSampler' })
})

test('progress bar and status line show the steps; VRAM warning marks the line', async () => {
  const p = { value: 3, max: 6, source: 'log' as const, t: 0 }
  expect(progressBar(p, 10)).toBe('█████░░░░░ 3/6')
  const s = toSample(0, parseSystemStats(SYSTEM_STATS), { running: 1, pending: 0 }, null)
  expect(statusLine(s, true, { progress: p, isVramHigh: true })).toBe('Comfy ● ON · 실행 1 · 대기 0 · 단계 3/6 · ⚠ VRAM 10.0/16G')
})

test('VRAM counts as high only after holding the line, and clears with a margin', async () => {
  const high = [sample(0, 15.5), sample(5_000, 15.6), sample(9_000, 15.7)]
  expect(vramHigh(high, 95, 10_000, false)).toBe(false)
  const held = [...high, sample(10_000, 15.6)]
  expect(vramHigh(held, 95, 10_000, false)).toBe(true)
  expect(vramHigh([...held, sample(12_000, 14.8)], 95, 10_000, true)).toBe(true)
  expect(vramHigh([...held, sample(12_000, 14.0)], 95, 10_000, true)).toBe(false)
  expect(vramHigh([sample(0, 15.6), sample(4_000, 10), sample(14_000, 15.6)], 95, 10_000, false)).toBe(false)
})

type World = { queue: string; history: string; toasts: string[]; statuses: (string | undefined)[]; stats: string }

function fakeComfy(on: On, world: World, bridgeLines: string[] = []) {
  on('http.fetch', async (_$, e) => {
    const text = e.url.endsWith('/system_stats') ? world.stats : e.url.includes('/history') ? world.history : world.queue
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '55, 61, 250', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: bridgeLines.map(line => `${line}\n`).join('') || ' ' }
    return { value: { code: 0, signal: null } }
  })
  on('ui.status', async (_$, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
}

const RUNNING = JSON.stringify({ queue_running: [[0, 'a1', { '3': { class_type: 'KSampler' } }, {}, []]], queue_pending: [] })
const IDLE = '{"queue_running":[],"queue_pending":[]}'

test('toasts a job that finishes while watching, not the ones already in history', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  mock.store(on)
  const world: World = { queue: RUNNING, history: '{}', toasts: [], statuses: [], stats: SYSTEM_STATS }
  fakeComfy(on, world)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_100)
  expect(world.toasts).toEqual([])

  world.queue = IDLE
  world.history = HISTORY
  await clock.advance(2_100)
  expect(world.toasts).toEqual(['ComfyUI 작업 완료 · 12.3초', 'ComfyUI 작업 실패 · 5.0초 · KSampler: CUDA out of memory'])

  await clock.advance(40_000)
  expect(world.toasts.length).toBe(2)

  const pane = await $.ui.mount({ plugin: 'comfy-monitor', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /✗ 실패 5.0초/ })).toBeDefined()
  await pane.unmount()
})

test('bridge lines show the sampler steps on the status line and the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  const world: World = { queue: RUNNING, history: '{}', toasts: [], statuses: [], stats: SYSTEM_STATS }
  fakeComfy(on, world, [
    '{"type":"bridge","ws":true,"log":"x.log"}',
    '{"type":"progress","value":4,"max":20,"source":"ws","node":"3"}',
  ])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(4_100)
  expect(world.statuses.at(-1)).toBe('Comfy ● ON · 실행 1 · 대기 0 · 단계 4/20 · VRAM 10.0/16G · GPU 55%')

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'comfy-monitor', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /KSampler/ })).toBeDefined()
    await pane.unmount()
  }
})

test('warns once when VRAM stays at 95% or more', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  const full = JSON.parse(SYSTEM_STATS)
  full.devices[0].vram_free = 0.3 * GB
  const world: World = { queue: IDLE, history: '{}', toasts: [], statuses: [], stats: JSON.stringify(full) }
  fakeComfy(on, world)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(8_100)
  expect(world.toasts).toEqual([])
  await clock.advance(6_000)
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toContain('VRAM 15.7/16G (98%)')
  expect(world.statuses.at(-1)).toContain('⚠ VRAM')
  await clock.advance(20_000)
  expect(world.toasts.length).toBe(1)
})

test('keeps recent jobs and samples in the store for the next session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store: Record<string, unknown> = {
    jobs: [{ id: 'old1', result: 'success', endedAt: 900_000, durationMs: 4_000 }],
    samples: [sample(300_000, 3), sample(990_000, 7)],
  }
  on('store.get', async (_$, e) => ({ value: store[e.key] }))
  on('store.set', async (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  const world: World = { queue: IDLE, history: '{}', toasts: [], statuses: [], stats: SYSTEM_STATS }
  fakeComfy(on, world)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'comfy-monitor', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: /old1/ })).toBeDefined()
  await pane.unmount()

  world.history = HISTORY
  await clock.advance(31_000)
  expect((store.jobs as { id: string }[]).map(j => j.id)).toEqual(['old1', 'b2', 'a1'])
  // the sample from over 10 minutes ago stayed behind; new ones were added
  const kept = (store.samples as { t: number }[]).map(x => x.t)
  expect(kept[0]).toBe(990_000)
  expect(kept.length).toBeGreaterThan(2)
})
