/* dsh-voice-call — client half.
 * A GPT/豆包-style voice call for the DeepSeek Harness Web GUI:
 *  - floating call button above the composer
 *  - full-screen call overlay (mic waveform, status, mute, hangup)
 *  - mic capture via getUserMedia + ScriptProcessor (downsampled to 16k mono)
 *  - energy VAD: silence 800ms finalizes an utterance, 12s hard cap
 *  - utterance -> POST /api/dsh-voice/talk -> SSE stream of audio frames
 *  - WebAudio playback with a queue; barge-in interrupts her mid-sentence
 */
window.__ModuleLoader__.load({
  id: "dsh-voice-call",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var reactDOMClient = require("react-dom/client");
    var createRootFn = reactDOMClient.createRoot || (reactDOMClient.default && reactDOMClient.default.createRoot);
    var h = react.createElement;

    // ---- config ---------------------------------------------------------
    var API = "/api/dsh-voice";
    var RMS_THRESHOLD = 0.010;
    var SILENCE_MS = 800;
    var MAX_UTTER_MS = 12000;
    var CHUNK_SAMPLES = 1600; // 100 ms @ 16 kHz
    var MIN_UTTER_SAMPLES = 480; // 30 ms

    // ---- tiny store -----------------------------------------------------
    var store = {
      open: false,
      status: "idle", // idle|connecting|listening|thinking|speaking|error
      error: null,
      lastUser: "",
      assistant: "",
      muted: false,
      engine: "",
      model: "",
      voice: "",
    };
    var listeners = [];
    function setStore(patch) {
      for (var k in patch) store[k] = patch[k];
      for (var i = 0; i < listeners.length; i++) listeners[i]();
    }
    function useStore() {
      var tick = react.useState(0)[1];
      react.useEffect(function () {
        function l() { tick(Date.now()); }
        listeners.push(l);
        return function () {
          listeners = listeners.filter(function (x) { return x !== l; });
        };
      }, []);
      return store;
    }

    // ---- audio plumbing -------------------------------------------------
    var audioCtx = null;
    var masterGain = null;
    var playQueue = [];
    var playing = false;
    var currentSrc = null;

    var mic = {
      stream: null,
      srcNode: null,
      proc: null,
      analyser: null,
      raf: 0,
      pending: [],
      recording: false,
      chunks: [],
      silenceMs: 0,
      totalMs: 0,
      rem: 0,
    };
    var talkAbort = null;
    var overlayHost = null;
    var overlayRoot = null;

    // ---- styles ---------------------------------------------------------
    var CSS = [
      ".dshvc-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:999px;border:1px solid rgba(37,99,235,.5);background:linear-gradient(135deg,rgba(37,99,235,.16),rgba(124,58,237,.16));color:inherit;font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;transition:box-shadow .2s,transform .1s;user-select:none}",
      ".dshvc-btn:hover{box-shadow:0 0 12px rgba(59,130,246,.5)}",
      ".dshvc-btn:active{transform:scale(.96)}",
      ".dshvc-btn-active{border-color:rgba(239,68,68,.6);background:rgba(239,68,68,.12);animation:dshvcPulse 1.6s ease-in-out infinite}",
      "@keyframes dshvcPulse{0%,100%{box-shadow:0 0 2px rgba(239,68,68,.4)}50%{box-shadow:0 0 14px rgba(239,68,68,.9)}}",
      ".dshvc-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 800px at 50% 30%,rgba(30,58,138,.55),rgba(2,6,23,.94));backdrop-filter:blur(14px);font-family:inherit;color:#e2e8f0}",
      ".dshvc-card{width:min(400px,92vw);text-align:center;padding:26px 20px 18px;border-radius:28px;border:1px solid rgba(96,165,250,.22);background:linear-gradient(180deg,rgba(30,58,138,.35),rgba(15,23,42,.55));box-shadow:0 24px 60px rgba(0,0,0,.55)}",
      ".dshvc-avatar-wrap{position:relative;width:120px;height:120px;margin:4px auto 10px;display:flex;align-items:center;justify-content:center}",
      ".dshvc-avatar{width:104px;height:104px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:52px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);box-shadow:0 0 0 4px rgba(255,255,255,.06),0 0 30px rgba(59,130,246,.45);position:relative;z-index:2;user-select:none}",
      ".dshvc-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(96,165,250,.55);animation:dshvcRing 2.2s ease-out infinite;z-index:1}",
      ".dshvc-ring-2{animation-delay:1.1s}",
      "@keyframes dshvcRing{0%{transform:scale(.85);opacity:.9}100%{transform:scale(1.45);opacity:0}}",
      ".dshvc-ring-listen{border-color:rgba(96,165,250,.6)}",
      ".dshvc-ring-speak{border-color:rgba(74,222,128,.7);animation-duration:1.5s}",
      ".dshvc-ring-think{border-color:rgba(251,191,36,.7);animation-duration:2.6s}",
      ".dshvc-ring-err{border-color:rgba(248,113,113,.7);animation:none}",
      ".dshvc-name{font-size:20px;font-weight:600;letter-spacing:.5px}",
      ".dshvc-status{margin-top:4px;font-size:14px;color:#93c5fd;min-height:20px}",
      ".dshvc-status-err{color:#fca5a5}",
      ".dshvc-wave{width:320px;height:64px;margin:8px auto 2px;display:block}",
      ".dshvc-transcript{margin:6px auto 0;max-width:340px;font-size:12px;line-height:1.6;color:#94a3b8;text-align:left}",
      ".dshvc-you{color:#7dd3fc}",
      ".dshvc-her{color:#86efac}",
      ".dshvc-error{margin-top:8px;font-size:12px;color:#fca5a5;word-break:break-all}",
      ".dshvc-controls{display:flex;align-items:center;justify-content:center;gap:22px;margin-top:18px}",
      ".dshvc-ctl{width:54px;height:54px;border-radius:50%;border:none;font-size:22px;cursor:pointer;background:rgba(30,41,59,.85);border:1px solid rgba(148,163,184,.25);color:#e2e8f0;transition:transform .1s,background .2s}",
      ".dshvc-ctl:hover{transform:scale(1.06)}",
      ".dshvc-ctl-muted{background:rgba(234,179,8,.18);border-color:rgba(234,179,8,.5)}",
      ".dshvc-hangup{background:rgba(220,38,38,.85);border:none;transform:rotate(135deg)}",
      ".dshvc-hangup:hover{transform:rotate(135deg) scale(1.06)}",
      ".dshvc-foot{margin-top:14px;font-size:10px;color:#64748b;min-height:12px}",
    ].join("\n");
    var styleInjected = false;
    function ensureStyle() {
      if (styleInjected) return;
      styleInjected = true;
      var el = document.createElement("style");
      el.id = "dshvc-css";
      el.textContent = CSS;
      (document.head || document.documentElement).appendChild(el);
    }

    // ---- small utils ----------------------------------------------------
    function b64ToU8(b64) {
      var bin = atob(b64);
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    function computeRms(samples) {
      var sum = 0;
      for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      return Math.sqrt(sum / samples.length);
    }
    function encodeWav(samples, sr) {
      var n = samples.length;
      var buf = new ArrayBuffer(44 + n * 2);
      var v = new DataView(buf);
      function wS(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
      wS(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); wS(8, "WAVE"); wS(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      wS(36, "data"); v.setUint32(40, n * 2, true);
      var p = 44;
      for (var i = 0; i < n; i++) {
        var s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        p += 2;
      }
      return new Uint8Array(buf);
    }
    function micErrorText(err) {
      if (!err) return "未知麦克风错误";
      var name = err.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") return "麦克风权限被拒绝：请在系统/浏览器设置中允许 DSH 使用麦克风后重试";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") return "没有找到麦克风设备";
      if (name === "NotReadableError" || name === "TrackStartError") return "麦克风被其他程序占用，请关闭占用后重试";
      return "麦克风错误：" + (err.message || name);
    }

    // ---- audio output ---------------------------------------------------
    function ensureAudio() {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        masterGain = audioCtx.createGain();
        masterGain.connect(audioCtx.destination);
      }
      if (audioCtx.state === "suspended") void audioCtx.resume();
    }
    function setMuted(m) {
      if (!masterGain || !audioCtx) return;
      try {
        masterGain.gain.setTargetAtTime(m ? 0 : 1, audioCtx.currentTime, 0.01);
      } catch (e) {
        masterGain.gain.value = m ? 0 : 1;
      }
    }
    function enqueueAudio(b64) {
      try {
        var u8 = b64ToU8(b64);
        audioCtx.decodeAudioData(u8.buffer).then(function (buf) {
          if (!store.open) return;
          playQueue.push(buf);
          pump();
        }).catch(function () {});
      } catch (e) {}
    }
    function pump() {
      if (playing || playQueue.length === 0 || !audioCtx) return;
      var buf = playQueue.shift();
      var src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(masterGain);
      currentSrc = src;
      playing = true;
      src.onended = function () {
        if (currentSrc === src) currentSrc = null;
        playing = false;
        pump();
      };
      src.start();
    }
    function stopPlayback() {
      playing = false;
      playQueue = [];
      if (currentSrc) {
        try { currentSrc.stop(); } catch (e) {}
        currentSrc = null;
      }
    }

    // ---- mic + VAD ------------------------------------------------------
    function downsample(input) {
      var step = audioCtx.sampleRate / 16000;
      var out = [];
      for (var i = 0; i < input.length; i++) {
        mic.rem += 1;
        while (mic.rem >= step) {
          mic.rem -= step;
          out.push(input[i]);
        }
      }
      return out;
    }
    function onChunk(samples) {
      if (mic.muted) {
        mic.recording = false;
        mic.chunks = [];
        mic.silenceMs = 0;
        mic.totalMs = 0;
        return;
      }
      var rms = computeRms(samples);
      var isSpeech = rms >= RMS_THRESHOLD;
      var status = store.status;
      if (!mic.recording) {
        if (isSpeech) {
          // barge-in while she is speaking / thinking
          if (status === "speaking" || status === "thinking") {
            bargeIn();
            setStore({ status: "listening" });
          }
          mic.recording = true;
          mic.chunks = [samples];
          mic.silenceMs = 0;
          mic.totalMs = 100;
        }
        return;
      }
      mic.chunks.push(samples);
      mic.totalMs += 100;
      mic.silenceMs = isSpeech ? 0 : mic.silenceMs + 100;
      if (mic.silenceMs >= SILENCE_MS || mic.totalMs >= MAX_UTTER_MS) finalizeUtterance();
    }
    function finalizeUtterance() {
      var chunks = mic.chunks;
      mic.chunks = [];
      mic.recording = false;
      mic.silenceMs = 0;
      mic.totalMs = 0;
      var n = 0;
      for (var i = 0; i < chunks.length; i++) n += chunks[i].length;
      if (n < MIN_UTTER_SAMPLES) return;
      var all = new Float32Array(n);
      var o = 0;
      for (var i = 0; i < chunks.length; i++) {
        all.set(chunks[i], o);
        o += chunks[i].length;
      }
      startTalk(encodeWav(all, 16000));
    }
    function startMic() {
      if (mic.stream) return Promise.resolve(true);
      ensureAudio();
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      }).then(function (stream) {
        mic.stream = stream;
        mic.srcNode = audioCtx.createMediaStreamSource(stream);
        mic.analyser = audioCtx.createAnalyser();
        mic.analyser.fftSize = 256;
        mic.proc = audioCtx.createScriptProcessor(4096, 1, 1);
        mic.proc.onaudioprocess = function (e) {
          var down = downsample(e.inputBuffer.getChannelData(0));
          if (down.length) {
            mic.pending.push.apply(mic.pending, down);
            while (mic.pending.length >= CHUNK_SAMPLES) {
              onChunk(mic.pending.splice(0, CHUNK_SAMPLES));
            }
          }
        };
        mic.srcNode.connect(mic.proc);
        mic.proc.connect(audioCtx.destination); // silent pull so onaudioprocess fires
        mic.proc.connect(mic.analyser);
        return true;
      }).catch(function (err) {
        setStore({ status: "error", error: micErrorText(err) });
        return false;
      });
    }
    function stopMic() {
      cancelAnimationFrame(mic.raf);
      if (mic.stream) {
        try { mic.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      }
      try { if (mic.srcNode) mic.srcNode.disconnect(); } catch (e) {}
      try { if (mic.proc) mic.proc.disconnect(); } catch (e) {}
      mic.stream = null;
      mic.srcNode = null;
      mic.proc = null;
      mic.analyser = null;
      mic.pending = [];
      mic.recording = false;
      mic.chunks = [];
      mic.silenceMs = 0;
      mic.totalMs = 0;
      mic.rem = 0;
    }

    // ---- talk / SSE -----------------------------------------------------
    function startTalk(wav) {
      if (store.status === "speaking" || store.status === "thinking") return;
      setStore({ status: "thinking", error: null });
      if (talkAbort) { try { talkAbort.abort(); } catch (e) {} }
      var ac = new AbortController();
      talkAbort = ac;
      fetch(API + "/talk", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: wav,
        signal: ac.signal,
      }).then(function (res) {
        if (!res.ok || !res.body) {
          res.text().then(function (t) {
            setStore({ status: "error", error: "语音通道异常 (" + res.status + ")" + (t && t.length < 200 ? " " + t : "") });
          }).catch(function () {
            setStore({ status: "error", error: "语音通道异常 (" + res.status + ")" });
          });
          return null;
        }
        return readSse(res.body);
      }).catch(function (err) {
        if (err && err.name === "AbortError") return;
        setStore({ status: "error", error: "通话异常：" + ((err && err.message) || err) });
      }).then(function () {
        if (talkAbort === ac) talkAbort = null;
      });
    }
    async function readSse(body) {
      var reader = body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          var line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          var data = line.slice(5).trim();
          if (!data) continue;
          var ev;
          try { ev = JSON.parse(data); } catch (e) { continue; }
          handleEvent(ev);
        }
      }
    }
    function handleEvent(ev) {
      if (!ev || typeof ev.type !== "string") return;
      switch (ev.type) {
        case "user":
          setStore({ lastUser: ev.text || "", assistant: "" });
          break;
        case "llm":
          setStore({ assistant: store.assistant + (ev.text || "") });
          break;
        case "audio":
          enqueueAudio(ev.b64);
          break;
        case "state":
          if (ev.state === "thinking" || ev.state === "speaking") setStore({ status: ev.state });
          break;
        case "done":
          setStore({ status: "listening" });
          break;
        case "interrupted":
          stopPlayback();
          setStore({ status: "listening" });
          break;
        case "error":
          stopPlayback();
          setStore({ status: "error", error: ev.message || "出错了" });
          break;
        case "warn":
          break;
      }
    }
    function bargeIn() {
      stopPlayback();
      if (talkAbort) { try { talkAbort.abort(); } catch (e) {} talkAbort = null; }
      fetch(API + "/interrupt", { method: "POST" }).catch(function () {});
    }

    // ---- call control ---------------------------------------------------
    function openCall() {
      if (store.open) return;
      ensureAudio();
      setStore({ open: true, status: "connecting", error: null, lastUser: "", assistant: "", muted: false });
      fetch(API + "/status", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (s && s.ok) setStore({ engine: s.engine, model: s.model, voice: s.voice });
        })
        .catch(function () {});
      startMic().then(function (ok) {
        if (ok) setStore({ status: "listening" });
      });
    }
    function closeCall() {
      stopPlayback();
      stopMic();
      if (talkAbort) { try { talkAbort.abort(); } catch (e) {} talkAbort = null; }
      fetch(API + "/interrupt", { method: "POST" }).catch(function () {});
      fetch(API + "/reset", { method: "POST" }).catch(function () {});
      setStore({ open: false, status: "idle", error: null, lastUser: "", assistant: "" });
      setTimeout(function () {
        if (audioCtx) {
          try { audioCtx.close(); } catch (e) {}
          audioCtx = null;
          masterGain = null;
        }
      }, 300);
    }
    function toggleMute() {
      var m = !store.muted;
      setStore({ muted: m });
      setMuted(m);
    }

    // ---- components -----------------------------------------------------
    var STATUS_TEXT = {
      idle: "准备就绪",
      connecting: "正在接通…",
      listening: "聆听中…",
      thinking: "思考中…",
      speaking: "说话中…",
      error: "",
    };

    function CallButton() {
      var s = useStore();
      return h(
        "div",
        { style: { display: "flex", justifyContent: "center" } },
        h(
          "button",
          {
            className: "dshvc-btn" + (s.open ? " dshvc-btn-active" : ""),
            onClick: function () { if (s.open) closeCall(); else openCall(); },
            title: "大黑鲸语音通话（本地语音识别 + edge-tts 合成）",
          },
          s.open ? "🔴 通话中…" : "🐋 语音通话"
        )
      );
    }

    function Wave() {
      var ref = react.useRef(null);
      react.useEffect(function () {
        var canvas = ref.current;
        if (!canvas) return;
        var ctx2d = canvas.getContext("2d");
        var running = true;
        function draw() {
          if (!running) return;
          var w = canvas.width, hgt = canvas.height;
          ctx2d.clearRect(0, 0, w, hgt);
          var status = store.status;
          if (status === "thinking" || status === "connecting") {
            var t = Date.now() / 380;
            for (var i = 0; i < 3; i++) {
              var y = hgt / 2 + Math.sin(t + i * 0.9) * hgt * 0.14;
              ctx2d.beginPath();
              ctx2d.arc(w / 2 - 22 + i * 22, y, 5, 0, Math.PI * 2);
              ctx2d.fillStyle = "rgba(147,197,253,0.9)";
              ctx2d.fill();
            }
          } else if (status === "listening" || status === "speaking") {
            if (mic.analyser) {
              var data = new Uint8Array(mic.analyser.frequencyBinCount);
              mic.analyser.getByteFrequencyData(data);
              var bars = 48, bw = w / bars;
              var rgb = status === "speaking" ? "74,222,128" : "96,165,250";
              for (var b = 0; b < bars; b++) {
                var v = data[b] / 255;
                var bh = Math.max(2, v * hgt * 0.9);
                ctx2d.fillStyle = "rgba(" + rgb + "," + (0.45 + 0.55 * v) + ")";
                ctx2d.fillRect(b * bw + 1, (hgt - bh) / 2, bw - 2, bh);
              }
            } else {
              ctx2d.fillStyle = "rgba(148,163,184,0.4)";
              ctx2d.fillRect(w / 2 - 30, hgt / 2 - 1, 60, 2);
            }
          } else if (status === "error") {
            ctx2d.fillStyle = "rgba(248,113,113,0.7)";
            ctx2d.fillRect(w / 2 - 30, hgt / 2 - 1, 60, 2);
          } else {
            ctx2d.fillStyle = "rgba(148,163,184,0.4)";
            ctx2d.fillRect(w / 2 - 30, hgt / 2 - 1, 60, 2);
          }
          raf = requestAnimationFrame(draw);
        }
        var raf = requestAnimationFrame(draw);
        return function () { running = false; cancelAnimationFrame(raf); };
      }, []);
      return h("canvas", { ref: ref, className: "dshvc-wave", width: 320, height: 64 });
    }

    function CallOverlay() {
      var s = useStore();
      if (!s.open) return null;
      var ringBase = "dshvc-ring";
      if (s.status === "speaking") ringBase += " dshvc-ring-speak";
      else if (s.status === "thinking") ringBase += " dshvc-ring-think";
      else if (s.status === "error") ringBase += " dshvc-ring-err";
      else ringBase += " dshvc-ring-listen";
      var statusText = s.status === "error" && s.error ? s.error : (STATUS_TEXT[s.status] || "");
      return h(
        "div",
        { className: "dshvc-overlay" },
        h(
          "div",
          { className: "dshvc-card" },
          h(
            "div",
            { className: "dshvc-avatar-wrap" },
            h("div", { className: "dshvc-avatar" }, s.status === "error" ? "😵" : "🐋"),
            h("span", { className: ringBase }),
            h("span", { className: ringBase + " dshvc-ring-2" })
          ),
          h("div", { className: "dshvc-name" }, "大黑鲸"),
          h("div", { className: "dshvc-status" + (s.status === "error" ? " dshvc-status-err" : "") }, statusText),
          h(Wave, {}),
          s.error && s.status === "error" ? h("div", { className: "dshvc-error" }, s.error) : null,
          s.lastUser || s.assistant
            ? h(
                "div",
                { className: "dshvc-transcript" },
                s.lastUser ? h("div", { className: "dshvc-you" }, "你：" + s.lastUser) : null,
                s.assistant ? h("div", { className: "dshvc-her" }, "🐋：" + s.assistant) : null
              )
            : null,
          h(
            "div",
            { className: "dshvc-controls" },
            h("button", { className: "dshvc-ctl" + (s.muted ? " dshvc-ctl-muted" : ""), onClick: toggleMute, title: s.muted ? "取消静音" : "静音" }, s.muted ? "🔇" : "🎤"),
            h("button", { className: "dshvc-ctl dshvc-hangup", onClick: closeCall, title: "挂断" }, "📞")
          ),
          h("div", { className: "dshvc-foot" }, [s.model, s.voice ? " · " + s.voice : "", s.engine === "ready" ? "" : " · 引擎 " + s.engine].join(""))
        )
      );
    }

    // ---- plugin entry ---------------------------------------------------
    function ensureOverlay() {
      if (overlayHost) return;
      overlayHost = document.createElement("div");
      overlayHost.id = "dshvc-overlay-host";
      document.body.appendChild(overlayHost);
      overlayRoot = createRootFn(overlayHost);
      overlayRoot.render(h(CallOverlay));
    }

    function apply(ctx) {
      ensureStyle();
      setTimeout(ensureOverlay, 0);
      ctx.slots.inject("conversation.input.dock", function () {
        return ctx.slots.register({
          name: "conversation.input.dock",
          id: "voice-call",
          order: 60,
        }, CallButton);
      });
    }

    exports.name = "dsh-voice-call";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  }
});
