# comfy-monitor

A Claude Code mod that shows ComfyUI usage without opening the ComfyUI window. A one-line status line, plus a pane with 10-minute charts of GPU, VRAM, RAM and the queue, the running job's sampler steps, and the recent jobs. Handy when you run ComfyUI headless.

ComfyUI 사용량을 Claude Code 안에서 보여 주는 mod입니다. 상태줄에 한 줄 요약을, 패널에 GPU·VRAM·RAM·큐의 최근 10분 그래프와 현재 작업 진행률, 최근 작업 목록을 띄웁니다. ComfyUI 창을 띄우지 않고(헤드리스) 돌릴 때 쓰기 좋습니다.

## Install / 설치

In the Claude Code input box:

Claude Code 터미널 세션의 입력창에서:

```
/plugin install comfy-monitor --marketplace aquarius21c/comfy-monitor
```

From a shell:

셸에서:

```
claude plugin install comfy-monitor --marketplace aquarius21c/comfy-monitor
```

Desktop app (where `/plugin` is unavailable): **+** next to the input box → **Plugins** → **Add marketplace** → enter `aquarius21c/comfy-monitor` → **Add plugin**.

데스크톱 앱(`/plugin`이 안 되는 곳): 입력창 옆 **+** → **Plugins** → **Add marketplace**에 `aquarius21c/comfy-monitor` → **Add plugin**.

### Requirements / 필요한 것

- A local ComfyUI (default `http://127.0.0.1:8188`)<br>로컬 ComfyUI (기본 `http://127.0.0.1:8188`)
- `nvidia-smi` for GPU usage<br>GPU 사용률용 `nvidia-smi`
- A Python with `websocket-client` for step progress (`pip install websocket-client`; usually already in the comfy-cli venv)<br>단계 진행률용 `websocket-client`가 설치된 Python (보통 comfy-cli를 설치한 venv에 이미 있음)

If `comfy` or `python` is not on your PATH, set the full paths in `comfyBin` and `pythonBin`.

`comfy`나 `python`이 PATH에 없으면 설정의 `comfyBin`, `pythonBin`에 전체 경로를 넣으세요.

## Usage / 사용

Open the pane with `/comfy-monitor`. Status line example:

`/comfy-monitor`로 패널을 엽니다. 상태줄 예시:

```
Comfy ● ON · Run 1 · Wait 2 · 단계 4/20 · VRAM 9.4/16G · GPU 87%
```

`Run` = running jobs, `Wait` = queued jobs, `단계` = sampler step. `⚠` appears before VRAM when it stays high, and the line becomes `Comfy ○ OFF` when ComfyUI does not respond.

`Run` = 실행 중, `Wait` = 대기 중, `단계` = 샘플러 단계. VRAM이 높게 유지되면 VRAM 앞에 `⚠`가 붙고, ComfyUI가 응답하지 않으면 `Comfy ○ OFF`로 바뀝니다.

| Command / 명령 | Description / 동작 |
| --- | --- |
| `/comfy-monitor` | Open the pane (starts polling if it was off)<br>패널 열기 (꺼져 있으면 조회 시작) |
| `/comfy-monitor on` / `off` | Start / stop polling<br>조회 시작 / 중지 |
| `/comfy-monitor stop` | Stop the ComfyUI that comfy-cli launched (`comfy stop`). Asks first if jobs remain; `stop now` forces it<br>comfy-cli가 띄운 ComfyUI 종료. 작업이 남아 있으면 먼저 물어봄(`stop now`로 강제) |

**Notifications (toasts):** a job finishes, fails or is interrupted (run time, failed node and message); VRAM stays above the threshold for over 10 s.

**알림(토스트):** 작업 완료·실패·중단(소요 시간, 실패 노드와 메시지), VRAM이 기준 이상으로 10초 넘게 지속될 때.

## Settings / 설정

Set in `/config` or `pluginConfigs.comfy-monitor` in settings.

`/config` 또는 settings의 `pluginConfigs.comfy-monitor`에서 바꿉니다.

| Key / 키 | Default / 기본값 | Meaning / 뜻 |
| --- | --- | --- |
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI address<br>ComfyUI 주소 |
| `intervalSeconds` | `2` | Poll interval in seconds<br>조회 주기(초) |
| `useNvidiaSmi` | `true` | Read GPU usage, temperature and power with `nvidia-smi`<br>`nvidia-smi`로 GPU 사용률·온도·전력 읽기 |
| `autoStart` | `true` | Start polling when a session starts<br>세션 시작 때 조회 시작 |
| `comfyBin` | `comfy` | comfy-cli used by `/comfy-monitor stop`<br>`stop`이 실행할 comfy-cli |
| `useBridge` | `true` | Run the step-progress helper `hooks/comfy_ws_bridge.py`<br>단계 진행률 보조 스크립트 실행 |
| `pythonBin` | `python` | Python for the helper (needs `websocket-client`)<br>보조 스크립트용 Python |
| `comfyLog` | (empty / 비움) | Log to read progress from; empty uses comfy-cli's `background_log`<br>진행률을 읽을 로그. 비우면 comfy-cli 설정의 `background_log` |
| `vramWarnPercent` | `95` | VRAM warning threshold (%)<br>VRAM 경고 기준(%) |

## Data sources / 데이터 출처

- `GET /system_stats`: VRAM, torch VRAM, RAM, version, devices<br>VRAM, torch VRAM, RAM, 버전, 장치
- `GET /queue`: running and queued counts, node types of the running prompt<br>실행·대기 수, 실행 중인 프롬프트의 노드 종류
- `GET /history?max_items=10`: finished jobs; read when the queue shrinks and every 30 s<br>끝난 작업. 큐가 줄 때와 30초마다 읽음
- `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw`
- `hooks/comfy_ws_bridge.py`: sampler step n/m (see below)<br>샘플러 단계 n/m (아래 설명)

ComfyUI sends `progress` only to the client that queued the job, so the helper connects to `/ws` under its own id (jobs queued without a client_id) and also reads the tqdm bars in the comfy-cli log (every job on a ComfyUI launched by comfy-cli). It never uses another client's id. If you launched ComfyUI Desktop, point `comfyLog` at its log file.

ComfyUI는 `progress`를 작업을 넣은 클라이언트에게만 보내므로, 보조 스크립트는 자기 id로 `/ws`에 붙고(client_id 없이 넣은 작업) comfy-cli 로그의 tqdm 막대도 함께 읽습니다(comfy-cli로 띄운 ComfyUI의 모든 작업). 다른 클라이언트의 id는 절대 쓰지 않습니다. ComfyUI Desktop으로 띄웠다면 `comfyLog`에 로그 경로를 지정하세요.

The last 20 jobs and the last 10 minutes of samples are kept in the mod store and carry over to the next session. After 3 failed polls in a row the line shows OFF and is rechecked every 10 s.

최근 작업 20개와 최근 10분 샘플은 mod 저장소에 남아 다음 세션에서 이어집니다. 연속 3번 조회에 실패하면 OFF로 표시하고 10초마다 다시 확인합니다.

## Development / 개발

```
claude plugin validate .
claude plugin test .
```

## License / 라이선스

MIT. See `LICENSE`.

MIT. `LICENSE` 파일을 보세요.
