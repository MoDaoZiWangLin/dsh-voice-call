# dsh-voice-call engine — local STT (sherpa-onnx) + streaming TTS (edge-tts).
# stdlib-only HTTP sidecar; the DSH host talks to it over 127.0.0.1.
#
#   GET  /health            -> {"ok":true,"asr":...,"tts":...,"voice":...}
#   POST /stt   (raw wav)   -> {"text": "..."}  (16k mono 16-bit PCM RIFF)
#   POST /tts   (json)      -> streamed audio/mpeg  {"text": "...", "voice": "...", "rate": "+0%"}
#
# Env:
#   DSH_VOICE_ENGINE_PORT   default 18765
#   DSH_VOICE_MODEL_DIR     default <plugin>/models/sherpa-onnx-zipformer-zh-en-2023-11-22
#   DSH_VOICE_TTS_VOICE     default zh-CN-XiaoxiaoNeural
import asyncio, io, json, os, queue, struct, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = HERE.parent / "models" / "sherpa-onnx-zipformer-zh-en-2023-11-22"
MODEL_DIR = Path(os.environ.get("DSH_VOICE_MODEL_DIR", DEFAULT_MODEL))
PORT = int(os.environ.get("DSH_VOICE_ENGINE_PORT", "18765"))
DEFAULT_VOICE = os.environ.get("DSH_VOICE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")

recognizer = None
recognizer_error = None


def load_recognizer():
    global recognizer, recognizer_error
    try:
        import sherpa_onnx
    except Exception as e:  # noqa: BLE001
        recognizer_error = f"sherpa_onnx import failed: {e}"
        return
    encoder = MODEL_DIR / "encoder-epoch-34-avg-19.int8.onnx"
    if not encoder.exists():
        encoder = MODEL_DIR / "encoder-epoch-34-avg-19.onnx"
    joiner = MODEL_DIR / "joiner-epoch-34-avg-19.int8.onnx"
    if not joiner.exists():
        joiner = MODEL_DIR / "joiner-epoch-34-avg-19.onnx"
    tokens = MODEL_DIR / "tokens.txt"
    if not (encoder.exists() and (MODEL_DIR / "decoder-epoch-34-avg-19.onnx").exists() and tokens.exists()):
        recognizer_error = f"model files missing under {MODEL_DIR}"
        return
    try:
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(encoder),
            decoder=str(MODEL_DIR / "decoder-epoch-34-avg-19.onnx"),
            joiner=str(joiner),
            tokens=str(tokens),
            num_threads=2,
            sample_rate=16000,
            feature_dim=80,
            decoding_method="greedy_search",
        )
    except Exception as e:  # noqa: BLE001
        recognizer_error = f"recognizer init failed: {e}"
        return
    recognizer_error = None


# ---------------------------------------------------------------------------
# WAV decoding: accept RIFF WAVE (any rate/channels/bits) -> float32 mono 16k
# ---------------------------------------------------------------------------
def wav_to_float32_mono16k(data: bytes):
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    fmt = None
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        (chunk_size,) = struct.unpack_from("<I", data, offset + 4)
        body_start = offset + 8
        if chunk_id == b"fmt ":
            fmt = data[body_start : body_start + chunk_size]
            if chunk_size < 16:
                raise ValueError("fmt chunk too small")
        elif chunk_id == b"data":
            pcm = data[body_start : body_start + chunk_size]
            break
        offset = body_start + chunk_size + (chunk_size & 1)
    if fmt is None:
        raise ValueError("missing fmt chunk")
    (audio_format, channels, rate, _, _, bits) = struct.unpack_from("<HHIIHH", fmt, 0)
    if audio_format == 0xFFFE:  # WAVE_FORMAT_EXTENSIBLE
        bits = struct.unpack_from("<H", fmt, 18)[0]
    samples = _decode_pcm(pcm, bits, channels)
    if rate != 16000:
        samples = _resample(samples, rate, 16000)
    if channels > 1:
        samples = _downmix(samples, channels)
    return samples


def _decode_pcm(pcm: bytes, bits: int, channels: int):
    n = len(pcm) // (bits // 8) // channels
    if bits == 16:
        raw = struct.unpack(f"<{n * channels}h", pcm)
        return [v / 32768.0 for v in raw]
    if bits == 32:
        # assume int32 PCM
        raw = struct.unpack(f"<{n * channels}i", pcm)
        return [v / 2147483648.0 for v in raw]
    if bits == 8:
        return [(v - 128) / 128.0 for v in pcm[: n * channels]]
    raise ValueError(f"unsupported bits {bits}")


def _downmix(samples, channels):
    out = []
    for i in range(0, len(samples) - channels + 1, channels):
        out.append(sum(samples[i : i + channels]) / channels)
    return out


def _resample(samples, src_rate, dst_rate):
    if src_rate == dst_rate:
        return samples
    n = int(len(samples) * dst_rate / src_rate)
    out = []
    for i in range(n):
        pos = i * src_rate / dst_rate
        i0 = int(pos)
        i1 = min(i0 + 1, len(samples) - 1)
        frac = pos - i0
        out.append(samples[i0] * (1 - frac) + samples[i1] * frac)
    return out


# ---------------------------------------------------------------------------
# STT
# ---------------------------------------------------------------------------
def transcribe(wav_bytes: bytes):
    if recognizer is None:
        raise RuntimeError(recognizer_error or "ASR not loaded")
    import numpy as np

    samples = wav_to_float32_mono16k(wav_bytes)
    if not samples:
        return ""
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, np.asarray(samples, dtype=np.float32))
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


# ---------------------------------------------------------------------------
# TTS (streaming via edge-tts)
# ---------------------------------------------------------------------------
def synthesize_stream(text, voice, rate, out_queue):
    async def _run():
        import edge_tts

        communicate = edge_tts.Communicate(text, voice, rate=rate)
        try:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    out_queue.put(chunk["data"])
        finally:
            out_queue.put(None)

    asyncio.run(_run())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silence
        pass

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self, limit=16 * 1024 * 1024):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > limit:
            raise ValueError("body too large")
        return self.rfile.read(length)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._json(200, {
                "ok": recognizer is not None,
                "asr": "sherpa-onnx" if recognizer is not None else (recognizer_error or "not-ready"),
                "tts": "edge-tts",
                "voice": DEFAULT_VOICE,
                "model": str(MODEL_DIR),
            })
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        try:
            if path == "/stt":
                body = self._read_body()
                text = transcribe(body)
                self._json(200, {"ok": True, "text": text})
            elif path == "/tts":
                body = self._read_body(limit=64 * 1024)
                payload = json.loads(body.decode("utf-8"))
                text = str(payload.get("text", "")).strip()
                voice = str(payload.get("voice", DEFAULT_VOICE))
                rate = str(payload.get("rate", "+0%"))
                if not text:
                    self._json(400, {"ok": False, "error": "empty text"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                q = queue.Queue()
                t = threading.Thread(target=synthesize_stream, args=(text, voice, rate, q), daemon=True)
                t.start()
                while True:
                    chunk = q.get()
                    if chunk is None:
                        break
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
                try:
                    self.wfile.flush()
                except Exception:  # noqa: BLE001
                    pass
            else:
                self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:  # noqa: BLE001
            try:
                self._json(500, {"ok": False, "error": str(e)})
            except Exception:  # noqa: BLE001
                pass


def main():
    load_recognizer()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[dsh-voice-engine] listening on 127.0.0.1:{PORT}  asr={'ready' if recognizer else 'FAILED:'+str(recognizer_error)}  tts=edge-tts")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
