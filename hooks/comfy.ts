import type { Job, Progress, Sample } from '../types'

const GB = 1024 ** 3

export type SystemStats = {
  vramTotal: number
  vramFree: number
  torchVramTotal: number
  ramTotal: number
  ramFree: number
  version: string
  device: string
}

export type QueueCounts = {
  running: number
  pending: number
  /** the running prompt's node id → class_type, for naming the node in progress */
  nodeTypes?: Record<string, string>
}

export type GpuStats = { gpu: number; temp: number; power: number }

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

export function parseSystemStats(text: string): SystemStats {
  const json = JSON.parse(text) as {
    system?: { ram_total?: unknown; ram_free?: unknown; comfyui_version?: unknown }
    devices?: {
      name?: unknown
      vram_total?: unknown
      vram_free?: unknown
      torch_vram_total?: unknown
    }[]
  }
  const device = json.devices?.[0] ?? {}

  return {
    vramTotal: num(device.vram_total),
    vramFree: num(device.vram_free),
    torchVramTotal: num(device.torch_vram_total),
    ramTotal: num(json.system?.ram_total),
    ramFree: num(json.system?.ram_free),
    version: typeof json.system?.comfyui_version === 'string' ? json.system.comfyui_version : '',
    device: typeof device.name === 'string' ? shortDevice(device.name) : '',
  }
}

/** "cuda:0 NVIDIA GeForce RTX 5080 : cudaMallocAsync" → "RTX 5080" */
export function shortDevice(name: string): string {
  const match = /(RTX|GTX|RX|Arc)\s*[\w ]*?\d{3,4}\w*/.exec(name)

  return match ? match[0].trim() : name.split(':')[0]?.trim() ?? name
}

export function parseQueue(text: string): QueueCounts {
  const json = JSON.parse(text) as { queue_running?: unknown[]; queue_pending?: unknown[] }

  const running = Array.isArray(json.queue_running) ? json.queue_running : []
  // each entry is [number, prompt_id, graph, extra_data, outputs]
  const graph = (running[0] as unknown[] | undefined)?.[2]
  const nodeTypes: Record<string, string> = {}
  if (graph && typeof graph === 'object') {
    for (const [id, node] of Object.entries(graph as Record<string, { class_type?: unknown }>)) {
      if (typeof node?.class_type === 'string') nodeTypes[id] = node.class_type
    }
  }

  return {
    running: running.length,
    pending: Array.isArray(json.queue_pending) ? json.queue_pending.length : 0,
    ...(Object.keys(nodeTypes).length > 0 ? { nodeTypes } : {}),
  }
}

type HistoryMessage = [string, { timestamp?: unknown; node_type?: unknown; exception_message?: unknown }]

/** Finished prompts in `/history?max_items=n`, newest first. */
export function parseHistory(text: string): Job[] {
  const json = JSON.parse(text) as Record<string, { status?: { status_str?: unknown; messages?: unknown } }>
  const jobs: Job[] = []
  for (const [id, entry] of Object.entries(json)) {
    const messages = (Array.isArray(entry?.status?.messages) ? entry.status.messages : []) as HistoryMessage[]
    const at = (kind: string) => messages.find(m => Array.isArray(m) && m[0] === kind)?.[1]
    const start = num(at('execution_start')?.timestamp)
    const error = at('execution_error')
    const interrupted = at('execution_interrupted')
    const end = Math.max(0, ...messages.map(m => num(m?.[1]?.timestamp)))
    const result: Job['result'] = error ? 'error' : interrupted ? 'interrupted' : 'success'
    if (result === 'success' && entry?.status?.status_str !== 'success') continue
    const job: Job = { id, result, endedAt: end, durationMs: start > 0 && end >= start ? end - start : 0 }
    if (error) {
      const message = typeof error.exception_message === 'string' ? (error.exception_message.trim().split(/\r?\n/)[0] ?? '').trim() : ''
      job.error = [typeof error.node_type === 'string' ? error.node_type : '', message].filter(Boolean).join(': ')
    }
    jobs.push(job)
  }

  return jobs.sort((a, b) => b.endedAt - a.endedAt)
}

/** 12.3초, 2분 5초, 1시간 3분 */
export function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 ${Math.round(s % 60)}초`

  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}

const RESULT_TEXT = { success: '완료', error: '실패', interrupted: '중단' } as const

/** The toast for a job that just finished. */
export function jobToast(job: Job): string {
  const time = job.durationMs > 0 ? ` · ${formatDuration(job.durationMs)}` : ''
  const error = job.error ? ` · ${job.error.slice(0, 80)}` : ''

  return `ComfyUI 작업 ${RESULT_TEXT[job.result]}${time}${error}`
}

/** One row of the recent jobs list. */
export function jobLine(job: Job, now: number): string {
  const mark = job.result === 'success' ? '✓' : job.result === 'error' ? '✗' : '■'
  const ago = Math.max(0, Math.round((now - job.endedAt) / 60_000))
  const when = ago < 1 ? '방금' : ago < 60 ? `${ago}분 전` : `${Math.floor(ago / 60)}시간 전`
  const time = job.durationMs > 0 ? formatDuration(job.durationMs) : '-'

  return `${mark} ${RESULT_TEXT[job.result]} ${time} · ${when} · ${job.id.slice(0, 8)}${job.error ? ` · ${job.error.slice(0, 40)}` : ''}`
}

/** A text bar for the running prompt's steps: ██████░░░░ 3/6 */
export function progressBar(progress: Progress, width: number): string {
  const ratio = progress.max > 0 ? Math.min(1, Math.max(0, progress.value / progress.max)) : 0
  const filled = Math.round(ratio * width)

  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${progress.value}/${progress.max}`
}

/**
 * Whether VRAM counts as high: on once use reaches `percent` and has stayed
 * there `holdMs`, off again once it drops 5 points under it.
 */
export function vramHigh(samples: readonly Sample[], percent: number, holdMs: number, wasHigh: boolean): boolean {
  const last = samples[samples.length - 1]
  if (!last || last.vramTotal <= 0) return false
  const pct = (s: Sample) => (s.vramUsed / s.vramTotal) * 100
  if (wasHigh) return pct(last) >= percent - 5
  if (pct(last) < percent) return false
  let since = last.t
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i]
    if (!s || pct(s) < percent) break
    since = s.t
  }

  return last.t - since >= holdMs
}

/** First line of `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits` */
export function parseNvidiaSmi(stdout: string): GpuStats | null {
  const line = stdout.split(/\r?\n/).find(row => row.trim() !== '')
  if (!line) return null
  const parts = line.split(',').map(part => Number.parseFloat(part.trim()))
  const [gpu, temp, power] = parts
  if (gpu === undefined || Number.isNaN(gpu)) return null

  return {
    gpu,
    temp: temp === undefined || Number.isNaN(temp) ? 0 : temp,
    power: power === undefined || Number.isNaN(power) ? 0 : power,
  }
}

export function toSample(
  t: number,
  stats: SystemStats,
  queue: QueueCounts,
  gpu: GpuStats | null,
): Sample {
  return {
    t,
    vramUsed: (stats.vramTotal - stats.vramFree) / GB,
    vramTotal: stats.vramTotal / GB,
    torchVram: stats.torchVramTotal / GB,
    ramUsed: (stats.ramTotal - stats.ramFree) / GB,
    ramTotal: stats.ramTotal / GB,
    running: queue.running,
    pending: queue.pending,
    gpu: gpu?.gpu ?? null,
    temp: gpu?.temp ?? null,
    power: gpu?.power ?? null,
  }
}

/** Run 1 · Wait 2 */
export function queueLabel(running: number, pending: number): string {
  return `Run ${running} · Wait ${pending}`
}

export function statusLine(
  sample: Sample | undefined,
  isOnline: boolean,
  extra: { progress?: Progress | null; isVramHigh?: boolean } = {},
): string {
  if (!isOnline || !sample) return 'Comfy ○ OFF'
  const { progress, isVramHigh = false } = extra
  const parts = [queueLabel(sample.running, sample.pending)]
  if (progress && sample.running > 0 && progress.max > 0) {
    parts.push(`단계 ${progress.value}/${progress.max}`)
  }
  parts.push(`${isVramHigh ? '⚠ ' : ''}VRAM ${sample.vramUsed.toFixed(1)}/${Math.round(sample.vramTotal)}G`)
  if (sample.gpu !== null) parts.push(`GPU ${Math.round(sample.gpu)}%`)

  return `Comfy ● ON · ${parts.join(' · ')}`
}
