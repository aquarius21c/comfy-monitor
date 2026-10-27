# comfy-monitor

ComfyUI 사용량을 Claude Code 안에서 보여 주는 mod입니다. 상태줄에 한 줄 요약을, 패널에 GPU·VRAM·RAM·큐의 최근 10분 그래프와 현재 작업 진행률, 최근 작업 목록을 띄웁니다. ComfyUI 창을 띄우지 않고(헤드리스) 돌릴 때 쓰기 좋습니다.

## 설치

Claude Code 터미널 세션의 입력창에서:

```
/plugin install comfy-monitor --marketplace aquarius21c/comfy-monitor
```

셸에서:

```
claude plugin install comfy-monitor --marketplace aquarius21c/comfy-monitor
```

데스크톱 앱(`/plugin`이 안 되는 곳): 입력창 옆 **+** → **Plugins** → **Add marketplace**에 `aquarius21c/comfy-monitor` → **Add plugin**.

필요한 것: 로컬 ComfyUI(기본 `http://127.0.0.1:8188`), GPU 사용률용 `nvidia-smi`, 단계 진행률용 `websocket-client`가 설치된 Python(`pip install websocket-client`, 보통 comfy-cli를 설치한 venv에 이미 있음). `comfy`나 `python`이 PATH에 없으면 설정의 `comfyBin`, `pythonBin`에 전체 경로를 넣으세요.

## 사용

`/comfy-monitor`로 패널을 엽니다. 상태줄 예시:

```
Comfy ● ON · 실행 1 · 대기 2 · 단계 4/20 · VRAM 9.4/16G · GPU 87%
```

VRAM이 높게 유지되면 VRAM 앞에 `⚠`가 붙고, ComfyUI가 응답하지 않으면 `Comfy ○ OFF`로 바뀝니다.

| 명령 | 동작 |
| --- | --- |
| `/comfy-monitor` | 패널 열기 (꺼져 있으면 조회 시작) |
| `/comfy-monitor on` / `off` | 조회 시작 / 중지 |
| `/comfy-monitor stop` | comfy-cli가 띄운 ComfyUI 종료(`comfy stop`). 작업이 남아 있으면 먼저 물어봄(`stop now`로 강제) |

알림(토스트): 작업 완료·실패·중단(소요 시간, 실패 노드와 메시지), VRAM이 기준 이상으로 10초 넘게 지속될 때.

설정 (`/config` 또는 settings의 `pluginConfigs.comfy-monitor`):

| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI 주소 |
| `intervalSeconds` | `2` | 조회 주기(초) |
| `useNvidiaSmi` | `true` | `nvidia-smi`로 GPU 사용률·온도·전력 읽기 |
| `autoStart` | `true` | 세션 시작 때 조회 시작 |
| `comfyBin` | `comfy` | `/comfy-monitor stop`이 실행할 comfy-cli |
| `useBridge` | `true` | 단계 진행률 보조 스크립트 `hooks/comfy_ws_bridge.py` 실행 |
| `pythonBin` | `python` | 보조 스크립트용 Python (`websocket-client` 필요) |
| `comfyLog` | 비움 | 진행률을 읽을 로그. 비우면 comfy-cli 설정의 `background_log` |
| `vramWarnPercent` | `95` | VRAM 경고 기준(%) |

## 데이터 출처

- `GET /system_stats`: VRAM, torch VRAM, RAM, 버전, 장치
- `GET /queue`: 실행·대기 수, 실행 중인 프롬프트의 노드 종류
- `GET /history?max_items=10`: 끝난 작업. 큐가 줄 때와 30초마다 읽음
- `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw`
- `hooks/comfy_ws_bridge.py`: 샘플러 단계 n/m. ComfyUI는 `progress`를 작업을 넣은 클라이언트에게만 보내므로, 보조 스크립트는 자기 id로 `/ws`에 붙고(client_id 없이 넣은 작업) comfy-cli 로그의 tqdm 막대도 함께 읽습니다(comfy-cli로 띄운 ComfyUI의 모든 작업). 다른 클라이언트의 id는 절대 쓰지 않습니다. ComfyUI Desktop으로 띄웠다면 `comfyLog`에 로그 경로를 지정하세요.

최근 작업 20개와 최근 10분 샘플은 mod 저장소에 남아 다음 세션에서 이어집니다. 연속 3번 조회에 실패하면 OFF로 표시하고 10초마다 다시 확인합니다.

## 개발

```
claude plugin validate .
claude plugin test .
```

## 라이선스

MIT. `LICENSE` 파일을 보세요.

---

## English summary

comfy-monitor is a Claude Code mod that shows ComfyUI usage without opening the ComfyUI window: a status line (`Comfy ● ON · 실행 1 · 대기 2 · 단계 4/20 · VRAM 9.4/16G · GPU 87%`, or `Comfy ○ OFF`) and a pane with 10-minute charts of GPU, VRAM, RAM and the queue, the running prompt's sampler steps, and the last finished jobs. It toasts when a job finishes, fails or is interrupted, and when VRAM stays at or over 95% for 10 s. Recent jobs and samples survive across sessions.

Install with `/plugin install comfy-monitor --marketplace aquarius21c/comfy-monitor`. It needs a local ComfyUI (`http://127.0.0.1:8188` by default), `nvidia-smi` for GPU %, and a Python with `websocket-client` for the step progress helper (`hooks/comfy_ws_bridge.py`, which reads ComfyUI's websocket under its own client id and the comfy-cli log's tqdm bars). Commands: `/comfy-monitor` (open the pane), `on` / `off`, `stop` (stop the ComfyUI comfy-cli launched). The UI text is Korean; settings are listed in the table above.

License: MIT (see `LICENSE`).
