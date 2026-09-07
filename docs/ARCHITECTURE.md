# Architecture

`dsh-voice-call` is a DSH plugin with three moving parts:

```
┌─────────────────────────── browser (DSH Web GUI) ───────────────────────────┐
│  client.js (window.__ModuleLoader__ module)                                  │
│   ├─ CallButton  → slot `conversation.input.dock`                            │
│   ├─ CallOverlay → React root mounted on document.body (portal)              │
│   ├─ mic: getUserMedia → ScriptProcessor → downsample 16k mono               │
│   ├─ VAD: 100ms RMS chunks, speech ≥ 0.010, silence 800ms finalize, 12s cap  │
│   ├─ WAV encode (PCM16/16k) → POST /api/dsh-voice/talk (SSE response)        │
│   ├─ SSE: decode audio frames → decodeAudioData → queue → AudioBufferSource  │
│   └─ barge-in: speech detected while speaking/thinking → /interrupt          │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ HTTP (same-origin, loopback-guarded)
┌──────────────────────────────────▼──────────────────── DSH host ────────────┐
│  index.js (cordis plugin, injected: webServer, credentials)                  │
│   ├─ routes: GET /status · POST /talk (SSE) · POST /interrupt · POST /reset │
│   ├─ talk(): STT → LLM stream (OpenAI-compatible, rolling history, persona) │
│   ├─ sentence-split (。！？!?\n…, flush at 36 chars) → TTS per sentence      │
│   └─ engine lifecycle: spawn engine/server.py, health-check, restart        │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ loopback HTTP
┌──────────────────────────────────▼──────────── python sidecar (engine/) ────┐
│  server.py (stdlib ThreadingHTTPServer)                                     │
│   ├─ /health → engine status                                                │
│   ├─ /stt    → wav bytes → sherpa-onnx offline zipformer (zh-en) → text     │
│   └─ /tts    → {text, voice} → edge-tts stream → audio/mpeg (streaming)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Host (index.js)

- **Route guard**: mirrors the `task-board` fence — loopback socket + loopback
  `Host` header + browser same-origin markers (`sec-fetch-site` / `Origin`).
- **LLM**: direct OpenAI-compatible streaming `POST {baseURL}/chat/completions`
  with `stream: true`, key resolved via `ctx.credentials.resolve(credentialRef(apiKeyEnv))`.
  No DSH LLM plumbing is touched, so a voice call never interferes with the
  running agent session. Model/provider defaults follow the DSH settings
  (`volcengine` / `deepseek-v4-flash`).
- **SSE framing**: `data: {json}\n\n`, heartbeat `: ping\n\n` every 15 s.
  Events: `user` (what you said), `llm` (sentence transcript), `audio` (base64
  mp3 frame), `state` (thinking/speaking), `done`, `interrupted`, `error`, `warn`.
- **Single active call**: one `talk` at a time; `/interrupt` aborts both the
  LLM fetch and the in-flight TTS.
- **Asset resolution**: DSH loads the host bundle from the profile's
  `node_modules` copy (a pnpm `file:` dep), which drops dot-dirs and heavy
  assets. `candidateRoots()` therefore resolves the python venv / ASR model
  across the bundle dir, `~/.dsh/plugins/dsh-voice-call`, and a dev checkout;
  the model path is passed to the sidecar via `DSH_VOICE_MODEL_DIR`.

## Client (client.js)

- Written as a plain `window.__ModuleLoader__.load({ id, factory })` module —
  no build step; `require("react")`, `require("react-dom/client")`.
- VAD runs in the browser on 100 ms chunks downsampled to 16 kHz. When speech
  ends (`silenceMs ≥ 800`), the utterance is WAV-encoded and POSTed; the
  response body is read as an SSE stream.
- Playback uses a queue of decoded `AudioBuffer`s through a master `GainNode`
  (mute). Barge-in stops the current source, aborts the request, and POSTs
  `/interrupt` before recording the new utterance.
- The overlay is mounted with `createRoot` on a host div appended to
  `document.body`, so it is not affected by ancestor CSS transforms.

## Engine (engine/server.py)

- Stdlib-only `ThreadingHTTPServer`; no framework dependency.
- STT: `sherpa_onnx.OfflineRecognizer.from_transducer` with the int8 zipformer
  bilingual zh-en model (`sherpa-onnx-zipformer-zh-en-2023-11-22`), greedy
  search, 2 threads. WAV parsing accepts any rate/channels/bits and resamples
  to 16k mono float32.
- TTS: `edge_tts.Communicate(...).stream()` pumped over a per-request thread
  into the HTTP response as `audio/mpeg` — the host forwards each chunk to the
  browser immediately.
- Engine lifecycle is owned by the host: spawned on plugin load, health-checked,
  restarted on crash, killed on dispose. Port default `18765` (127.0.0.1 only).
