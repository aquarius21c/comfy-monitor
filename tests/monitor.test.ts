import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SYSTEM_STATS } from './fixtures'

const QUEUE = '{"queue_running":[[1,"a"]],"queue_pending":[]}'
const run = (args: string) => ({
  command: 'comfy-monitor',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
}) as const

const PANE = {
  component: 'Pane',
  requestId: 'comfy-monitor',
  props: { title: 'ComfyUI', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function fakeComfy(on: On, state: { isUp: boolean; statuses: (string | undefined)[]; fetches: number }) {
  on('http.fetch', async (_$, e) => {
    state.fetches += 1
    if (!state.isUp) throw new Error('ECONNREFUSED')
    const text = e.url.endsWith('/system_stats') ? SYSTEM_STATS : QUEUE
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '55, 61, 250\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.status', async (_$, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
}

test('polls ComfyUI, fills the status line and draws the pane on each surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const state = { isUp: true, statuses: [] as (string | undefined)[], fetches: 0 }
  fakeComfy(on, state)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(4_100)

  expect(state.statuses.at(-1)).toBe('Comfy ● ON · 실행 1 · 대기 0 · VRAM 10.0/16G · GPU 55%')

  const terminal = await $.ui.mount({ plugin: 'comfy-monitor', surface: 'terminal', ...PANE })
  expect(await terminal.find({ type: 'Text', text: /RTX 5080/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /▁|▂|▃|▄|▅|▆|▇|█/ })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ plugin: 'comfy-monitor', surface: 'desktop', ...PANE })
  const charts = (await desktop.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
  expect(charts).toEqual(['GPU: 55% · 61°C · 250W', 'VRAM: 10.0 / 16 GB', 'RAM: 24.0 / 64 GB', '큐: 실행 1 · 대기 0'])
  await desktop.unmount()
})

test('shows off after three failed polls', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const state = { isUp: true, statuses: [] as (string | undefined)[], fetches: 0 }
  fakeComfy(on, state)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_100)
  state.isUp = false
  await clock.advance(8_100)

  expect(state.statuses.at(-1)).toBe('Comfy ○ OFF')
})

test('off stops polling and clears the line; on starts it again', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const state = { isUp: true, statuses: [] as (string | undefined)[], fetches: 0 }
  fakeComfy(on, state)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_100)

  const off = await $.command.run(run('off'))
  expect(off.text).toContain('껐습니다')
  expect(state.statuses.at(-1)).toBe(undefined)
  const before = state.fetches
  await clock.advance(10_000)
  expect(state.fetches).toBe(before)

  const back = await $.command.run(run('on'))
  expect(back.text).toContain('켜져 있습니다')
  await clock.advance(2_100)
  expect(state.fetches).toBeGreaterThan(before)
  expect(state.statuses.at(-1)).toContain('Comfy ●')
})

test('autoStart off waits for /comfy-monitor on', { options: { autoStart: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const state = { isUp: true, statuses: [] as (string | undefined)[], fetches: 0 }
  fakeComfy(on, state)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(6_000)
  expect(state.fetches).toBe(0)

  await $.command.run(run('on'))
  await clock.advance(100)
  expect(state.statuses.at(-1)).toContain('Comfy ●')
})

test('stop runs comfy stop, and asks first while jobs are running', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const state = { isUp: true, statuses: [] as (string | undefined)[], fetches: 0 }
  const argvs: (readonly string[])[] = []
  on('http.fetch', async (_$, e) => {
    if (!state.isUp) throw new Error('ECONNREFUSED')
    const text = e.url.endsWith('/system_stats') ? SYSTEM_STATS : QUEUE
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.run', async (_$, e) => {
    argvs.push(e.argv)
    const isStop = e.argv[1] === 'stop'
    if (isStop) state.isUp = false
    return {
      value: { exitCode: 0, stdout: isStop ? 'stopped' : '50, 60, 200', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.status', async (_$, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(100)

  const asked = await $.command.run(run('stop'))
  expect(asked.text).toContain('stop now')
  expect(argvs.some(argv => argv[1] === 'stop')).toBe(false)

  const done = await $.command.run(run('stop now'))
  expect(done.text).toContain('종료했습니다')
  expect(argvs.find(argv => argv[1] === 'stop')?.[0]).toContain('comfy')
  expect(state.statuses.at(-1)).toBe('Comfy ○ OFF')
})
