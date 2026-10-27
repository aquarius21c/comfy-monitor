# comfy-monitor

Claude Code mod that shows ComfyUI usage: a status line summary and a pane with
10-minute charts of GPU, VRAM, RAM and the queue, the running prompt's sampler
steps, and the last finished jobs.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install comfy-monitor --marketplace aquarius21c/comfy-monitor
```

From a shell:

```
claude plugin install comfy-monitor --marketplace aquarius21c/comfy-monitor
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box,
then Plugins, Add marketplace with `aquarius21c/comfy-monitor`, then Add plugin.

Requirements: a local ComfyUI (default `http://127.0.0.1:8188`), `nvidia-smi`
for GPU %, and for sampler steps a Python with `websocket-client`
(`pip install websocket-client`; the venv comfy-cli was installed into usually
has it). Set `pythonBin` and `comfyBin` to full paths if they are not on PATH.

## Use

`/comfy-monitor` opens the pane. The status line reads, for example,
`Comfy ● 실행 1 · 대기 2 · 단계 4/20 · VRAM 9.4/16G · GPU 87%`, with `⚠` before
VRAM while it stays high, or `Comfy ○ 꺼짐` when ComfyUI is not answering.

| Command | Does |
| --- | --- |
| `/comfy-monitor` | open the pane (starts polling if it was off) |
| `/comfy-monitor on` / `off` | start / stop polling |
| `/comfy-monitor stop` | stop the ComfyUI comfy-cli started (`comfy stop`); asks first while jobs remain (`stop now`) |

Toasts: a job finished, failed or was interrupted (with run time and the error),
and VRAM at or over `vramWarnPercent` for more than 10 s.

Settings (`/config` or `pluginConfigs.comfy-monitor` in settings):

| Key | Default | Meaning |
| --- | --- | --- |
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI server |
| `intervalSeconds` | `2` | Poll period |
| `useNvidiaSmi` | `true` | Read GPU %, temperature and power from `nvidia-smi` |
| `autoStart` | `true` | Poll from session start |
| `comfyBin` | `comfy` | Used by `/comfy-monitor stop` |
| `useBridge` | `true` | Run `hooks/comfy_ws_bridge.py` for sampler steps |
| `pythonBin` | `python` | Python with `websocket-client` for the bridge |
| `comfyLog` | empty | Log the bridge follows; empty reads comfy-cli's `background_log` |
| `vramWarnPercent` | `95` | VRAM warning line |

## Data

- `GET /system_stats`: VRAM, torch VRAM, RAM, version, device
- `GET /queue`: running and pending counts, the running prompt's node types
- `GET /history?max_items=10`: finished jobs, read when the queue shrinks and every 30 s
- `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw`
- `hooks/comfy_ws_bridge.py`: sampler steps. ComfyUI sends `progress` only to the
  client that queued a prompt, so the bridge joins `/ws` under its own id (for
  prompts queued without one) and follows the comfy-cli log's tqdm bars (every
  prompt of a ComfyUI that comfy-cli launched). It never takes another client's id.

Recent jobs (20) and the last 10 minutes of samples are kept in the mod's store
and come back in the next session.

Three failed polls in a row mark ComfyUI as off; it is then polled every 10 s.

## Develop

```
claude plugin validate .
claude plugin test .
```
