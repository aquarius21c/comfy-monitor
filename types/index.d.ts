export type Sample = {
  /** epoch ms */
  t: number
  vramUsed: number
  vramTotal: number
  torchVram: number
  ramUsed: number
  ramTotal: number
  running: number
  pending: number
  /** GPU 사용률 %, nvidia-smi가 없으면 null */
  gpu: number | null
  temp: number | null
  power: number | null
}

export type Status = {
  isOnline: boolean
  isPaused: boolean
  version: string
  device: string
  failures: number
  /** VRAM이 경고 기준을 넘은 채로 지속 중 */
  isVramHigh: boolean
}

/** A finished prompt from `/history`. */
export type Job = {
  id: string
  /** `success`, `error` or `interrupted` */
  result: 'success' | 'error' | 'interrupted'
  /** epoch ms the run ended */
  endedAt: number
  /** run time in ms, 0 when the history lacks a start */
  durationMs: number
  /** for an error: the node type and the message's first line */
  error?: string
}

/** The running prompt's sampler steps, from the bridge script. */
export type Progress = {
  value: number
  max: number
  /** node class, when the websocket named the node */
  node?: string
  source: 'ws' | 'log'
  /** epoch ms of the last update */
  t: number
}

declare module 'claude-code' {
  interface PluginState {
    'comfy-monitor': { samples: Sample[]; status: Status; jobs: Job[]; progress: Progress | null }
  }
}
