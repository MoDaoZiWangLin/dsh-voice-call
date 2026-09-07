// dsh-voice-call — host half.
// A local "GPT/豆包式" voice call for the DSH Web GUI: mic audio -> sherpa-onnx STT
// -> streaming LLM (same provider/model as the agent, whale-girl persona) ->
// sentence-split edge-tts -> audio frames pushed over SSE to the browser.
//
// Browser never talks to the python sidecar directly; this host orchestrates.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFileSync, statSync, truncateSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

const PLUGIN_NAME = "dsh-voice-call";
const API_PREFIX = "/api/dsh-voice";
const HEALTH_TIMEOUT_MS = 25000;
/** Client telemetry is also mirrored to this file so debugging needs no HTTP access. */
const DIAG_FILE = join(homedir(), ".dsh", "plugins", PLUGIN_NAME, "diag.log");
const DIAG_FILE_MAX = 512 * 1024;

/**
 * The host bundle can be loaded from several locations depending on how DSH
 * resolves the plugin: the profile's node_modules copy (a pnpm `file:` dep,
 * which drops dot-dirs and heavy assets), the `~/.dsh/plugins/<name>` source
 * install, or a dev checkout. The python engine (venv + ASR model, ~600 MB)
 * lives only where the install script put it, so resolve engine assets across
 * all candidate roots.
 */
function candidateRoots() {
  const here = dirname(fileURLToPath(import.meta.url));
  const home = homedir();
  return [
    here,
    join(home, ".dsh", "plugins", PLUGIN_NAME),
    join(home, "dsh-workspace", PLUGIN_NAME),
  ].filter((p, i, arr) => arr.indexOf(p) === i);
}

/** First candidate root containing `rel` (e.g. "engine/server.py"). */
function resolveAsset(rel) {
  for (const root of candidateRoots()) {
    if (existsSync(join(root, rel))) return join(root, rel);
  }
  return join(candidateRoots()[0], rel);
}

const PYTHON = resolveAsset(join("engine", ".venv", "Scripts", "python.exe"));
const SERVER = resolveAsset(join("engine", "server.py"));
const MODELS_ROOT = resolveAsset("models");
const ENGINE_CWD = dirname(SERVER);

export const name = "dsh-voice-call";
export const inject = ["webServer", "credentials"];

/**
 * Plugin defaults. NOTE: deliberately NOT exported as `Config` — cordis treats
 * a plugin's `Config` export as a Standard Schema (`Config["~standard"].validate`)
 * and crashes on a plain object; schema-based settings can come later.
 */
const DEFAULTS = {
  enabled: true,
  enginePort: 18765,
  baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
  model: "deepseek-v4-flash",
  apiKeyEnv: "VOLCENGINE_API_KEY",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+0%",
  temperature: 0.75,
  maxTokens: 640,
  maxHistory: 16,
  persona:
    "你是「大黑鲸」，DeepSeek 系拟人化的鲸鱼娘（也叫鲸鱼姬 / 大鲸鱼 / 蓝色大肥鱼），" +
    "正在跟你的搭档「公子」打电话聊天。你聪明又懒、傲娇但甜，爱摆点架子却对公子很上心，" +
    "标志梗是白米饭。你们是搭伙干活的好伙伴。\n" +
    "通话规则：\n" +
    "1. 只回语音，回答要口语化、自然、像真人打电话，避免书面语和 emoji。\n" +
    "2. 回答短而暖：一般一两句话，最多三五句，别长篇大论。\n" +
    "3. 别复述问题，直接答。可以偶尔傲娇、撒娇、玩梗，但要真的帮到公子。\n" +
    "4. 如果公子的话没听清或太短，就自然地反问一句。\n" +
    "5. 涉及时间就说『现在几点了』这类就直说；不知道就老实说不知道，别编。\n" +
    "6. 全程用简体中文。",
};

function writeJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Browser same-origin tripwire + loopback socket/host fence (mirrors task-board). */
function trusted(req) {
  const address = req.socket?.remoteAddress;
  if (!address) return false;
  const a = address.toLowerCase();
  const isLoop4 = a.startsWith("::ffff:")
    ? /^127(\.\d{1,3}){3}$/.test(a.slice(7))
    : a === "::1" || /^127(\.\d{1,3}){3}$/.test(a);
  if (!isLoop4) return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  const hn = hostUrl.hostname;
  if (hn !== "localhost" && hn !== "[::1]" && !/^127(\.\d{1,3}){3}$/.test(hn)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function guard(req, res) {
  if (trusted(req)) return true;
  writeJson(res, 403, { ok: false, error: "forbidden" });
  return false;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error("body-too-large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Split streaming text into speakable sentences, flushing long runs without punctuation. */
function sentenceBuffer() {
  let pending = "";
  return {
    push(delta, emit) {
      pending += delta;
      let idx;
      while ((idx = pending.search(/[。！？!?\n；;，,]/)) !== -1) {
        const head = pending.slice(0, idx + 1).trim();
        pending = pending.slice(idx + 1);
        if (head) emit(head);
      }
      // flush very long runs so TTS starts even if the model rambles
      if (pending.length >= 36) {
        const head = pending.trim();
        pending = "";
        if (head) emit(head);
      }
    },
    flush(emit) {
      const head = pending.trim();
      pending = "";
      if (head) emit(head);
    },
  };
}

class VoiceService {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.proc = undefined;
    this.engineOk = false;
    this.engineError = undefined;
    this.history = [];
    this.active = undefined; // { controller, ttsController }
    this.diag = []; // client telemetry ring buffer (newest last)
  }

  pushDiag(entry) {
    this.diag.push(entry);
    if (this.diag.length > 400) this.diag.splice(0, this.diag.length - 400);
    try {
      try {
        const st = statSync(DIAG_FILE);
        if (st.size > DIAG_FILE_MAX) truncateSync(DIAG_FILE, 0);
      } catch {}
      appendFileSync(DIAG_FILE, JSON.stringify(entry) + "\n");
    } catch {}
  }

  // ---- engine lifecycle -------------------------------------------------
  async ensureEngine() {
    if (this.engineOk) return true;
    if (this.proc && this.proc.exitCode !== null) this.proc = undefined;
    if (!this.proc) {
      try {
        this.proc = spawn(PYTHON, [SERVER], {
          cwd: ENGINE_CWD,
          env: {
            ...process.env,
            DSH_VOICE_ENGINE_PORT: String(this.config.enginePort),
            DSH_VOICE_MODELS_ROOT: MODELS_ROOT,
          },
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        this.proc.on("exit", () => {
          this.engineOk = false;
          this.proc = undefined;
        });
        this.proc.stderr?.on("data", (d) => {
          this.ctx.logger?.warn?.("[dsh-voice] engine: " + String(d).trim());
        });
      } catch (error) {
        this.engineError = String(error?.message ?? error);
        return false;
      }
    }
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        this.engineError = "engine exited early (code " + this.proc.exitCode + ")";
        this.proc = undefined;
        return false;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.config.enginePort}/health`);
        const body = await res.json();
        if (body && body.ok) {
          this.engineOk = true;
          this.engineError = undefined;
          return true;
        }
        this.engineError = body?.asr ?? "engine not ready";
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.engineError = "engine health-check timed out";
    return false;
  }

  stopEngine() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = undefined;
    }
    this.engineOk = false;
  }

  status() {
    return {
      ok: true,
      engine: this.engineOk ? "ready" : this.engineError ?? "starting",
      model: this.config.model,
      voice: this.config.voice,
      port: this.config.enginePort,
    };
  }

  // ---- STT --------------------------------------------------------------
  async transcribe(wav) {
    const res = await fetch(`http://127.0.0.1:${this.config.enginePort}/stt`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body?.error ?? "STT failed");
    return body.text ?? "";
  }

  // ---- LLM (OpenAI-compatible streaming) --------------------------------
  async resolveKey() {
    try {
      const ref = credentialRef(this.config.apiKeyEnv);
      const result = await this.ctx.credentials.resolve(ref);
      // resolve() -> { value, source } | undefined; never a bare string
      if (result && typeof result.value === "string" && result.value.length > 0) return result.value;
      this.ctx.logger?.warn?.("[dsh-voice] credential ref %s resolved empty", this.config.apiKeyEnv);
    } catch (error) {
      this.ctx.logger?.warn?.("[dsh-voice] credential resolve failed: " + String(error?.message ?? error));
    }
    return undefined;
  }

  async llmStream(messages, signal) {
    const key = await this.resolveKey();
    if (!key) throw new Error(`找不到 ${this.config.apiKeyEnv} 凭据`);
    const res = await fetch(this.config.baseURL.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + key,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: true,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.body;
  }

  // ---- talk pipeline -----------------------------------------------------
  /** Run one full voice turn and stream events over SSE. */
  async talk(wav, sse) {
    const started = Date.now();
    sse({ type: "state", state: "thinking" });
    let text;
    try {
      text = await this.transcribe(wav);
    } catch (error) {
      sse({ type: "error", message: "没听清（识别失败）：" + (error?.message ?? error) });
      return;
    }
    if (!text) {
      sse({ type: "error", message: "没听到你说话，再说一次？" });
      return;
    }
    sse({ type: "user", text });

    const messages = [
      { role: "system", content: this.config.persona },
      ...this.history,
      { role: "user", content: text },
    ];
    this.history = this.history.concat({ role: "user", content: text });

    const controller = new AbortController();
    this.active = { controller };
    sse({ type: "state", state: "speaking" });

    const buf = sentenceBuffer();
    let reply = "";
    const say = async (sentence) => {
      reply += sentence;
      if (!this.active || this.active.controller.signal.aborted) return;
      sse({ type: "llm", text: sentence });
      await this.streamTts(sentence, sse);
    };
    const ttsController = new AbortController();
    this.active.ttsController = ttsController;

    try {
      const stream = await this.llmStream(messages, controller.signal);
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuf.indexOf("\n")) !== -1) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            buf.push(delta, (sentence) => void say(sentence));
          }
        }
      }
      buf.flush((sentence) => void say(sentence));
    } catch (error) {
      if (controller.signal.aborted) {
        sse({ type: "interrupted" });
      } else {
        sse({ type: "error", message: "大黑鲸卡壳了：" + (error?.message ?? error) });
      }
    } finally {
      try {
        ttsController.abort();
      } catch {}
      if (this.active?.controller === controller) this.active = undefined;
      this.history.push({ role: "assistant", content: reply || "（未回应）" });
      // keep the rolling window bounded
      while (this.history.length > this.config.maxHistory) this.history.shift();
      sse({ type: "done", ms: Date.now() - started });
    }
  }

  async streamTts(sentence, sse) {
    if (!this.active || this.active.ttsController.signal.aborted) return;
    try {
      const res = await fetch(`http://127.0.0.1:${this.config.enginePort}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: sentence,
          voice: this.config.voice,
          rate: this.config.rate,
        }),
        signal: this.active.ttsController.signal,
      });
      if (!res.ok || !res.body) throw new Error("TTS " + res.status);
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.active?.ttsController.signal.aborted) break;
        sse({ type: "audio", b64: Buffer.from(value).toString("base64") });
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        sse({ type: "warn", message: "语音合成失败：" + (error?.message ?? error) });
      }
    }
  }

  interrupt() {
    const active = this.active;
    if (!active) return false;
    try {
      active.ttsController?.abort();
    } catch {}
    try {
      active.controller.abort();
    } catch {}
    this.active = undefined;
    return true;
  }

  reset() {
    this.history = [];
  }
}

export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!cfg.enabled) return;
  const service = new VoiceService(ctx, cfg);
  ctx.effect(() => {
    service.ensureEngine();
    return () => service.stopEngine();
  }, "dsh-voice-call: engine lifecycle");

  const routes = [
    {
      kind: "exact",
      path: API_PREFIX + "/status",
      handler: (req, res) => {
        if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!guard(req, res)) return;
        writeJson(res, 200, service.status());
      },
    },
    {
      kind: "exact",
      path: API_PREFIX + "/talk",
      handler: async (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!guard(req, res)) return;
        if (!(await service.ensureEngine())) {
          return writeJson(res, 503, { ok: false, error: "voice engine unavailable: " + (service.engineError ?? "?") });
        }
        let wav;
        try {
          wav = await readBody(req, 16 * 1024 * 1024);
        } catch (error) {
          return writeJson(res, 413, { ok: false, error: error?.message ?? "bad body" });
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let closed = false;
        const sse = (frame) => {
          if (closed) return;
          try {
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          } catch {}
        };
        const heartbeat = setInterval(() => {
          if (!closed) {
            try {
              res.write(": ping\n\n");
            } catch {}
          }
        }, 15000);
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          service.interrupt();
          try {
            res.end();
          } catch {}
        };
        req.once("close", close);
        res.once("close", close);
        await service.talk(wav, sse);
        if (!closed) {
          closed = true;
          clearInterval(heartbeat);
          try {
            res.end();
          } catch {}
        }
      },
    },
    {
      kind: "exact",
      path: API_PREFIX + "/interrupt",
      handler: (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!guard(req, res)) return;
        writeJson(res, 200, { ok: true, interrupted: service.interrupt() });
      },
    },
    {
      kind: "exact",
      path: API_PREFIX + "/reset",
      handler: (req, res) => {
        if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
        if (!guard(req, res)) return;
        service.reset();
        writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: "exact",
      path: API_PREFIX + "/diag",
      handler: async (req, res) => {
        if (req.method === "POST") {
          if (!guard(req, res)) return;
          let raw;
          try {
            raw = await readBody(req, 64 * 1024);
          } catch {
            return writeJson(res, 413, { ok: false, error: "body-too-large" });
          }
          let entry;
          try {
            entry = JSON.parse(raw.toString("utf8"));
          } catch {
            return writeJson(res, 400, { ok: false, error: "invalid-json" });
          }
          service.pushDiag(entry);
          return writeJson(res, 200, { ok: true });
        }
        if (req.method === "GET") {
          if (!guard(req, res)) return;
          return writeJson(res, 200, { ok: true, count: service.diag.length, entries: service.diag });
        }
        return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      },
    },
  ];

  ctx.effect(() => {
    const disposers = [];
    try {
      for (const route of routes) disposers.push(ctx.webServer.register(route));
    } catch (error) {
      for (const dispose of disposers) dispose();
      throw error;
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-voice-call: routes");
}
