import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, Progress, Sample, Status } from '../types'
import { sparkline, svgChart } from './chart'
import {
  jobLine,
  jobToast,
  parseHistory,
  parseNvidiaSmi,
  parseQueue,
  parseSystemStats,
  progressBar,
  queueLabel,
  statusLine,
  toSample,
  vramHigh,
} from './comfy'
import type { GpuStats } from './comfy'

const PANE = 'comfy-monitor'
const TITLE = 'ComfyUI'
/** 10 minutes at the default 2 s period. */
const CAPACITY = 300
/** Failed polls in a row before ComfyUI counts as off. */
const OFFLINE_AFTER = 3
/** Period while ComfyUI is off. */
const OFFLINE_INTERVAL_MS = 10_000
/** VRAM must stay over the warning line this long before the toast. */
const VRAM_HOLD_MS = 10_000
/** History is read when the queue shrinks, and at least this often. */
const HISTORY_EVERY_MS = 30_000
/** Recent jobs kept in state and in the store. */
const JOBS_KEPT = 20
/** Samples are written to the store at most this often. */
const SAVE_EVERY_MS = 30_000
/** A bridge that ended is started again after this. */
const BRIDGE_RETRY_MS = 30_000
/** Progress with no update for this long is dropped. */
const PROGRESS_STALE_MS = 120_000

const COLOR = { vram: '#7c6cf0', torch: '#c084fc', ram: '#2a9d8f', gpu: '#e76f51', running: '#3a86ff', pending: '#f4a261' }

const samples = atom({ plugin: 'comfy-monitor', key: 'samples' } as const, [] as Sample[])
const status = atom({ plugin: 'comfy-monitor', key: 'status' } as const, {
  isOnline: false,
  isPaused: false,
  version: '',
  device: '',
  failures: 0,
  isVramHigh: false,
} as Status)
const jobs = atom({ plugin: 'comfy-monitor', key: 'jobs' } as const, [] as Job[])
const progress = atom({ plugin: 'comfy-monitor', key: 'progress' } as const, null as Progress | null)

const NVIDIA_SMI = [
  'nvidia-smi',
  '--query-gpu=utilization.gpu,temperature.gpu,power.draw',
  '--format=csv,noheader,nounits',
]

type Config = {
  baseUrl: string
  intervalMs: number
  useNvidiaSmi: boolean
  autoStart: boolean
  comfyBin: string
  useBridge: boolean
  pythonBin: string
  comfyLog: string
  vramWarnPercent: number
}

/** Set by register; the module's own variables start over on each reload. */
const config: Config = {
  baseUrl: 'http://127.0.0.1:8188',
  intervalMs: 2000,
  useNvidiaSmi: true,
  autoStart: true,
  comfyBin: 'comfy',
  useBridge: true,
  pythonBin: 'python',
  comfyLog: '',
  vramWarnPercent: 95,
}
let timer: { cancel: () => void } | undefined
let currentMs = 0
let isPolling = false
let lastActive = -1
let lastHistoryAt = 0
let isHistorySeeded = false
let lastSavedAt = 0
let nodeTypes: Record<string, string> = {}
let bridge: AsyncGenerator<unknown, unknown> | undefined
let bridgeStartedAt = -Infinity

function schedule($: EngineInterface, ms: number): void {
  if (ms === currentMs && timer) return
  timer?.cancel()
  currentMs = ms
  // poll never throws past here: a reload can end the module mid-poll.
  timer = $.clock.every(ms, () => void poll($).catch(() => undefined))
}

function stop(): void {
  timer?.cancel()
  timer = undefined
  currentMs = 0
}

async function start($: EngineInterface): Promise<void> {
  await update($, status, s => ({ ...s, isPaused: false }))
  schedule($, config.intervalMs)
  void poll($).catch(() => undefined)
}

async function turnOff($: EngineInterface): Promise<void> {
  stop()
  stopBridge()
  await saveSamples($, true).catch(() => undefined)
  await update($, status, s => ({ ...s, isPaused: true, isOnline: false, failures: 0, isVramHigh: false }))
  await update($, progress, () => null)
  $.ui.status(undefined)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

/** Brings back the last session's jobs, and its samples from the last 10 minutes. */
async function restore($: EngineInterface): Promise<void> {
  if ((await read($, jobs)).length === 0) {
    const saved = await $.store.get('jobs').catch(() => undefined)
    if (Array.isArray(saved)) await update($, jobs, () => (saved as Job[]).slice(0, JOBS_KEPT))
  }
  if ((await read($, samples)).length === 0) {
    const saved = await $.store.get('samples').catch(() => undefined)
    const now = await $.clock.now()
    if (Array.isArray(saved)) {
      const recent = (saved as Sample[]).filter(x => now - x.t < CAPACITY * 2000).slice(-CAPACITY)
      if (recent.length > 0) await update($, samples, () => recent)
    }
  }
}

async function saveSamples($: EngineInterface, isForced = false): Promise<void> {
  const now = await $.clock.now()
  if (!isForced && now - lastSavedAt < SAVE_EVERY_MS) return
  lastSavedAt = now
  await $.store.set('samples', await read($, samples))
}

/**
 * Stops the ComfyUI that comfy-cli started in the background (`comfy launch
 * --background`, as comfy-mcp's launch_comfyui does). `comfy stop` without
 * `--port` touches only that one, never ComfyUI Desktop on the same port.
 */
async function stopComfy($: EngineInterface, isForced: boolean): Promise<string> {
  const last = (await read($, samples)).at(-1)
  const isBusy = (await read($, status)).isOnline && last !== undefined && last.running + last.pending > 0
  if (isBusy && !isForced && last) {
    return `작업이 남아 있습니다 (Run ${last.running}, Wait ${last.pending}). 그래도 끄려면 /comfy-monitor stop now`
  }

  let result
  try {
    result = await $.process.run([config.comfyBin, 'stop'], { timeoutMs: 60_000 })
  } catch {
    return `comfy-cli를 실행하지 못했습니다: ${config.comfyBin}. 설정의 comfyBin 경로를 확인하세요.`
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (result.exitCode === 0) {
    await update($, status, s => ({ ...s, isOnline: false, failures: OFFLINE_AFTER }))
    await update($, progress, () => null)
    $.ui.status(statusLine(undefined, false))
    return 'Claude가 띄운 ComfyUI를 종료했습니다.'
  }
  if (/No ComfyUI is running in the background/i.test(output)) {
    return 'Claude(comfy-cli)가 띄운 ComfyUI가 없습니다. ComfyUI Desktop은 이 명령으로 끄지 않습니다.'
  }

  return `종료하지 못했습니다 (exit ${result.exitCode}): ${output.trim().split(/\r?\n/).slice(-2).join(' ')}`
}

async function readGpu($: EngineInterface): Promise<GpuStats | null> {
  if (!config.useNvidiaSmi) return null
  try {
    const { exitCode, stdout } = await $.process.run(NVIDIA_SMI, { timeoutMs: 5000 })
    return exitCode === 0 ? parseNvidiaSmi(stdout) : null
  } catch {
    // nvidia-smi is missing: stop asking for the rest of this load.
    config.useNvidiaSmi = false
    return null
  }
}

/** Reads `/history`, adds the jobs not seen yet, and toasts them once seeded. */
async function readHistory($: EngineInterface): Promise<void> {
  lastHistoryAt = await $.clock.now()
  const res = await $.http.fetch(`${config.baseUrl}/history?max_items=10`)
  if (!res.ok) return
  const found = parseHistory(res.text)
  const known = await read($, jobs)
  const seen = new Set(known.map(j => j.id))
  const fresh = found.filter(j => !seen.has(j.id))
  if (fresh.length > 0) {
    const merged = [...fresh, ...known].sort((a, b) => b.endedAt - a.endedAt).slice(0, JOBS_KEPT)
    await update($, jobs, () => merged)
    await $.store.set('jobs', merged).catch(() => undefined)
  }
  if (isHistorySeeded) {
    for (const job of fresh.slice(0, 3).reverse()) $.ui.toast(jobToast(job), { timeoutMs: 8000 })
  }
  isHistorySeeded = true
}

async function onBridgeLine($: EngineInterface, line: string): Promise<void> {
  let msg: { type?: string; value?: number; max?: number; node?: string | null; source?: string }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'progress' && typeof msg.value === 'number' && typeof msg.max === 'number') {
    const { value, max } = msg
    const node = msg.node ? nodeTypes[msg.node] ?? msg.node : undefined
    const source = msg.source === 'ws' ? 'ws' : 'log'
    const t = await $.clock.now()
    const next: Progress = node ? { value, max, source, t, node } : { value, max, source, t }
    await update($, progress, () => next)
    return
  }
  if (msg.type === 'executed' || (msg.type === 'executing' && msg.node === null)) {
    lastHistoryAt = 0 // read the history on the next poll
    await update($, progress, () => null)
  }
}

async function readBridge($: EngineInterface, stream: AsyncGenerator<{ stream: string; text: string }, unknown>): Promise<void> {
  let rest = ''
  for await (const { stream: pipe, text } of stream) {
    if (pipe !== 'stdout') continue
    const lines = (rest + text).split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) await onBridgeLine($, line).catch(() => undefined)
  }
}

/** Starts the step progress script; its loop lives until the child or the module ends. */
function startBridge($: EngineInterface, now: number): void {
  if (!config.useBridge || bridge || now - bridgeStartedAt < BRIDGE_RETRY_MS) return
  bridgeStartedAt = now
  const argv = [config.pythonBin, '-u', `${$.plugin.root}/hooks/comfy_ws_bridge.py`, '--url', config.baseUrl]
  if (config.comfyLog) argv.push('--log', config.comfyLog)
  const stream = $.process.spawn({ argv, env: { PYTHONIOENCODING: 'utf-8' } })
  bridge = stream
  void readBridge($, stream)
    .catch(() => undefined)
    .finally(() => {
      if (bridge === stream) bridge = undefined
    })
}

function stopBridge(): void {
  void bridge?.return(undefined).catch(() => undefined)
  bridge = undefined
  bridgeStartedAt = -Infinity
}

async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    if ((await read($, status)).isPaused) return
    const [statsRes, queueRes, gpu] = await Promise.all([
      $.http.fetch(`${config.baseUrl}/system_stats`),
      $.http.fetch(`${config.baseUrl}/queue`),
      readGpu($),
    ])
    if (!statsRes.ok || !queueRes.ok) throw new Error(`HTTP ${statsRes.status}/${queueRes.status}`)
    const stats = parseSystemStats(statsRes.text)
    const queue = parseQueue(queueRes.text)
    const now = await $.clock.now()
    const sample = toSample(now, stats, queue, gpu)
    nodeTypes = queue.nodeTypes ?? {}

    const list = await update($, samples, l => [...l, sample].slice(-CAPACITY))
    const before = await read($, status)
    const isHigh = vramHigh(list, config.vramWarnPercent, VRAM_HOLD_MS, before.isVramHigh)
    await update($, status, s => ({
      ...s,
      isOnline: true,
      failures: 0,
      version: stats.version,
      device: stats.device,
      isVramHigh: isHigh,
    }))
    if (isHigh && !before.isVramHigh) {
      const pct = Math.round((sample.vramUsed / sample.vramTotal) * 100)
      const used = `${sample.vramUsed.toFixed(1)}/${Math.round(sample.vramTotal)}G`
      $.ui.toast(`⚠ ComfyUI VRAM ${used} (${pct}%), ${VRAM_HOLD_MS / 1000}초 넘게 높음`, { timeoutMs: 10_000 })
    }

    let current = await read($, progress)
    if (current && (sample.running === 0 || now - current.t > PROGRESS_STALE_MS)) {
      current = await update($, progress, () => null)
    }
    $.ui.status(statusLine(sample, true, { progress: current, isVramHigh: isHigh }))

    const active = sample.running + sample.pending
    const isShrunk = lastActive >= 0 && active < lastActive
    lastActive = active
    if (!isHistorySeeded || isShrunk || now - lastHistoryAt >= HISTORY_EVERY_MS) {
      await readHistory($).catch(() => undefined)
    }
    startBridge($, now)
    await saveSamples($).catch(() => undefined)
    schedule($, config.intervalMs)
  } catch {
    const next = await update($, status, s => {
      const failures = s.failures + 1
      return { ...s, failures, isOnline: s.isOnline && failures < OFFLINE_AFTER }
    })
    if (!next.isOnline) {
      lastActive = -1
      $.ui.status(statusLine(undefined, false))
      schedule($, OFFLINE_INTERVAL_MS)
    }
  } finally {
    isPolling = false
  }
}

function span(list: readonly Sample[]): string {
  const ms = (list[list.length - 1]?.t ?? 0) - (list[0]?.t ?? 0)
  return ms < 60_000 ? `최근 ${Math.round(ms / 1000)}초` : `최근 ${Math.round(ms / 60_000)}분`
}

export const register: Register = (on, options) => {
  config.baseUrl = String(options.comfyUrl ?? config.baseUrl).replace(/\/+$/, '')
  config.intervalMs = Math.max(1, Number(options.intervalSeconds ?? 2)) * 1000
  config.useNvidiaSmi = options.useNvidiaSmi !== false
  config.autoStart = options.autoStart !== false
  config.useBridge = options.useBridge !== false
  if (typeof options.comfyBin === 'string' && options.comfyBin.trim()) config.comfyBin = options.comfyBin.trim()
  if (typeof options.pythonBin === 'string' && options.pythonBin.trim()) config.pythonBin = options.pythonBin.trim()
  if (typeof options.comfyLog === 'string') config.comfyLog = options.comfyLog.trim()
  const warn = Number(options.vramWarnPercent ?? 95)
  config.vramWarnPercent = Number.isFinite(warn) && warn > 0 ? warn : 95
  const { baseUrl } = config

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'comfy-monitor',
      description: 'ComfyUI 모니터: 인자 없이 패널 열기, on/off 모니터 켜기·끄기, stop Claude가 띄운 ComfyUI 종료',
      argumentHint: '[on|off|stop]',
    })
    await restore($).catch(() => undefined)
    if (config.autoStart) await start($)
    else await update($, status, s => ({ ...s, isPaused: true }))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await saveSamples($, true).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'comfy-monitor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off') {
      await turnOff($)
      return { text: 'ComfyUI 모니터를 껐습니다. 다시 켜려면 /comfy-monitor on' }
    }
    if (arg === 'stop' || arg === 'stop now') {
      return { text: await stopComfy($, arg === 'stop now') }
    }
    if (arg !== '' && arg !== 'on') {
      return {
        text: '사용법: /comfy-monitor (패널 열기) · on (켜기) · off (끄기) · stop (Claude가 띄운 ComfyUI 종료, 작업 중이면 stop now)',
      }
    }
    if (arg === 'on' || (await read($, status)).isPaused) await start($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const where = opened.isPlaced ? '패널을 열었습니다.' : '창을 넓히면 패널이 보입니다.'

    return { text: `ComfyUI 모니터가 켜져 있습니다. ${where}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, samples)
    const s = await read($, status)
    const recent = (await read($, jobs)).slice(0, 5)
    const step = await read($, progress)
    const now = await $.clock.now()
    const last = list[list.length - 1]
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui

    const header = s.isOnline
      ? `● ON · ${s.device || 'GPU'}${s.version ? ` · v${s.version}` : ''}`
      : `○ OFF · ${baseUrl}`

    const controls = (
      <Box flexDirection="row">
        <Button
          key="pause"
          label={s.isPaused ? 'ON' : 'OFF'}
          onPress={() => (s.isPaused ? start($) : update($, status, x => ({ ...x, isPaused: true })))}
        />
        <Text> </Text>
        <Button key="clear" label="기록 지우기" onPress={() => update($, samples, () => [])} />
      </Box>
    )

    const room = Math.max(10, Math.min(60, (e.props.bodyColumns ?? 40) - 16))
    const isRunning = s.isOnline && (last?.running ?? 0) > 0
    const current = (
      <Box flexDirection="column">
        <Text>현재 작업</Text>
        {isRunning && step && step.max > 0 ? (
          <Text>
            {progressBar(step, Math.min(30, room))}
            <Text dimColor>{step.node ? ` · ${step.node}` : ''}</Text>
          </Text>
        ) : (
          <Text dimColor>{isRunning ? '실행 중 (단계 정보 없음)' : '없음'}</Text>
        )}
      </Box>
    )
    const history = (
      <Box flexDirection="column">
        <Text>최근 작업</Text>
        {recent.length === 0 ? (
          <Text dimColor>아직 없음</Text>
        ) : (
          recent.map(job =>
            job.result === 'error' ? (
              <Text key={job.id} color="red">
                {jobLine(job, now)}
              </Text>
            ) : (
              <Text key={job.id} dimColor>
                {jobLine(job, now)}
              </Text>
            ),
          )
        )}
      </Box>
    )
    const warning = s.isVramHigh ? <Text color="yellow">⚠ VRAM {config.vramWarnPercent}% 이상 지속 중</Text> : null

    if (!last) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{header}</Text>
          <Text dimColor>아직 받은 값이 없습니다.</Text>
          {history}
          {controls}
        </Box>
      )
    }

    const vram = list.map(x => x.vramUsed)
    const torch = list.map(x => x.torchVram)
    const ram = list.map(x => x.ramUsed)
    const gpu = list.map(x => x.gpu ?? 0)
    const running = list.map(x => x.running)
    const pending = list.map(x => x.pending)
    const queueMax = Math.max(1, ...running, ...pending)
    const hasGpu = last.gpu !== null

    const vramText = `${last.vramUsed.toFixed(1)} / ${last.vramTotal.toFixed(0)} GB`
    const ramText = `${last.ramUsed.toFixed(1)} / ${last.ramTotal.toFixed(0)} GB`
    const gpuText = hasGpu ? `${Math.round(last.gpu ?? 0)}% · ${Math.round(last.temp ?? 0)}°C · ${Math.round(last.power ?? 0)}W` : ''
    const queueText = queueLabel(last.running, last.pending)

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = 320
      const chart = (key: string, label: string, value: string, series: { values: number[]; color: string }[], max: number, isStep = false) => (
        <Svg
          key={key}
          alt={`${label}: ${value}`}
          width={width}
          height={72}
          source={svgChart({ series, max, capacity: CAPACITY, label, value, width, isStep })}
        />
      )

      return (
        <Box flexDirection="column">
          <Text dimColor>{header}</Text>
          {warning}
          {current}
          {hasGpu && chart('gpu', 'GPU', gpuText, [{ values: gpu, color: COLOR.gpu }], 100)}
          {chart('vram', 'VRAM', vramText, [{ values: vram, color: COLOR.vram }, { values: torch, color: COLOR.torch }], last.vramTotal)}
          {chart('ram', 'RAM', ramText, [{ values: ram, color: COLOR.ram }], last.ramTotal)}
          {chart('queue', '큐', queueText, [{ values: pending, color: COLOR.pending }, { values: running, color: COLOR.running }], queueMax, true)}
          <Text dimColor>{span(list)} · 보라 VRAM 전체, 연보라 torch 할당 · 큐 파랑 실행, 주황 대기</Text>
          {history}
          {controls}
        </Box>
      )
    }

    const row = (label: string, line: string, value: string) => (
      <Box flexDirection="column">
        <Text>
          {label.padEnd(5)} <Text dimColor>{value}</Text>
        </Text>
        <Text>{line}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>{header}</Text>
        {warning}
        {current}
        {hasGpu && row('GPU', sparkline(gpu, 100, room), gpuText)}
        {row('VRAM', sparkline(vram, last.vramTotal, room), vramText)}
        {row('RAM', sparkline(ram, last.ramTotal, room), ramText)}
        {row('큐', sparkline(running.map((r, i) => r + (pending[i] ?? 0)), queueMax, room), queueText)}
        {history}
        {controls}
      </Box>
    )
  })
}
