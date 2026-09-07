# dsh-voice-call 🐋📞

A **GPT / Doubao-style voice call** plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) desktop Web GUI. Press the call button, talk to your whale-girl companion, and hear her answer **out loud** — with streaming playback and barge-in interruption.

```
 you speak ──► mic (browser) ──► sherpa-onnx STT (local) ──► LLM stream (your configured provider)
     ▲                                                                              │
     │                                                                            sentences
     │                                                                              ▼
 you hear ◄── WebAudio playback ◄── SSE audio frames ◄── edge-tts TTS (local) ◄───┘
```

- 🔒 **Local speech engine** — STT (sherpa-onnx, offline) and TTS (edge-tts) run on your machine; no audio leaves your computer except the text sent to your normal LLM provider.
- ⚡ **Streaming end-to-end** — the assistant's reply is split into sentences and synthesized/played as it arrives, not after the whole answer.
- ✋ **Barge-in** — start talking mid-answer and she stops immediately and listens.
- 🐋 **Same brain as your agent** — calls the same model/provider you already configured (default: volcengine `deepseek-v4-flash`, OpenAI-compatible), wrapped in a whale-girl phone persona.
- 🎨 **Native-feeling UI** — floating call button above the composer, full-screen call overlay with waveform, live status (listening / thinking / speaking), mute, and hangup.

## Requirements

- Windows (DSH desktop app) — the engine scripts are PowerShell-based; the plugin itself is platform-agnostic.
- Python **3.10+** (3.14 works; wheels for sherpa-onnx/edge-tts exist for current versions).
- Network access at install time: PyPI (engine) + GitHub releases (ASR model, ~310 MB) + Microsoft (edge-tts, per synthesis) + your LLM provider.
- A configured DSH LLM provider with an OpenAI-compatible endpoint (the default reads `volcengine` / `deepseek-v4-flash` from your DSH settings).

## Install

```powershell
# from this repo
powershell -ExecutionPolicy Bypass -File scripts\install.ps1          # wires the "desktop" profile
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile all
```

The script:

1. syncs the repo into `~/.dsh/plugins/dsh-voice-call`,
2. creates a python venv with `sherpa-onnx` + `edge-tts` and downloads the bilingual zh-en ASR model (first run only),
3. idempotently adds `dsh-voice-call` to your DSH profile's `dependencies` + `bundles` and runs `pnpm install`.

**Restart the DSH desktop app.** After the restart a **「🐋 语音通话」** button appears above the composer.

> Manual wiring (if you prefer doing it by hand):
> ```jsonc
> // ~/.dsh/profiles/<profile>/package.json
> "dependencies": { "dsh-voice-call": "file:../../plugins/dsh-voice-call" },
> "dsh": { "profile": { "bundles": [ ..., "dsh-voice-call" ] } }
> ```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1          # unwire from profile
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DeleteFiles  # also delete ~/.dsh/plugins/dsh-voice-call
```

Restart the app afterwards.

## Usage

1. Click **🐋 语音通话** above the input box → the call overlay opens, mic permission is requested (grant it).
2. Just talk. After ~0.8 s of silence your utterance is transcribed and sent.
3. The whale answers **out loud**; the transcript appears on screen.
4. **Talk over her** any time to interrupt; she'll stop and listen to you.
5. Use 🎤 to mute, 📞 to hang up (hanging up also resets the conversation).

Status states: `connecting → listening → thinking → speaking → listening …`

## Configuration

The host-side plugin reads a schema-less config object with these defaults (override via your DSH plugin/settings layer):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `enginePort` | `18765` | local python engine port |
| `baseURL` | `https://ark.cn-beijing.volces.com/api/plan/v3` | LLM OpenAI-compatible base URL |
| `model` | `deepseek-v4-flash` | LLM model id |
| `apiKeyEnv` | `VOLCENGINE_API_KEY` | credential ref name (resolved via `ctx.credentials`) |
| `voice` | `zh-CN-XiaoxiaoNeural` | edge-tts voice |
| `rate` | `+0%` | edge-tts speaking rate |
| `temperature` | `0.75` | LLM temperature |
| `maxTokens` | `640` | LLM max output tokens |
| `maxHistory` | `16` | rolling conversation messages kept per call |
| `persona` | whale-girl | system prompt (edit to taste) |

Latency notes: with the default provider the model's first token typically lands in ~1–2 s; sentence TTS adds ~0.5–1 s before the first audio. For snappier replies pick a lower-latency provider/model in your DSH settings — the plugin follows the configured endpoint.

## Development

```powershell
git clone https://github.com/<you>/dsh-voice-call
cd dsh-voice-call
powershell -ExecutionPolicy Bypass -File scripts\install.ps1   # install into DSH
node --check index.js && node --check client.js                # syntax check
```

- Host half: `index.js` — cordis plugin, HTTP routes under `/api/dsh-voice/*` (`/status`, `/talk` SSE, `/interrupt`, `/reset`), engine process lifecycle.
- Client half: `client.js` — `window.__ModuleLoader__` module, UI injected into the `conversation.input.dock` slot; mic capture, VAD, WAV encoding, SSE, WebAudio playback, barge-in.
- Engine: `engine/server.py` — stdlib HTTP sidecar (`/health`, `/stt`, `/tts`); `engine/requirements.txt`.
- Docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PROGRESS.md](docs/PROGRESS.md).

## License

[MIT](LICENSE)
