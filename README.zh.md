# dsh-voice-call 🐋📞

![version](https://img.shields.io/badge/version-1.0.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Windows-4A90D9)
![STT](https://img.shields.io/badge/STT-sherpa--onnx-8A2BE2)
![TTS](https://img.shields.io/badge/TTS-edge--tts-FF6B35)
[![check](https://github.com/MoDaoZiWangLin/dsh-voice-call/actions/workflows/check.yml/badge.svg)](https://github.com/MoDaoZiWangLin/dsh-voice-call/actions/workflows/check.yml)

一个给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）桌面 Web GUI 做的 **GPT / 豆包式语音通话** 插件。按下通话键，跟鲸鱼娘大黑鲸说话，她会**开口回答**——流式播放、随时打断。

```
 你说话 ──► 麦克风(浏览器) ──► sherpa-onnx 本地识别 ──► LLM 流式(你已配置的 provider)
     ▲                                                                             │
     │                                                                          分句
     │                                                                             ▼
 你听到 ◄── WebAudio 播放 ◄── SSE 音频帧 ◄── edge-tts 本地合成 ◄────────────────┘
```

- 🔒 **本地语音引擎** — 识别（sherpa-onnx，离线）和合成（edge-tts）都在本机跑；除了发给 LLM 的文字，音频不出本机。
- ⚡ **全链路流式** — 回答按句切分，边生成边合成边播放，不用等整段。
- ✋ **说话打断（barge-in）** — 她正说着，你开口她就停，转头听你说。
- 🐋 **跟你的 agent 同一个脑子** — 直接调用你已配置的模型/provider（默认火山引擎 `deepseek-v4-flash`，OpenAI 兼容接口），套上鲸鱼娘打电话人设。
- 🎨 **原生感 UI** — 输入框上方悬浮通话按钮、全屏通话浮层（波形、状态灯：聆听/思考/说话、静音、挂断）。

## 截图

> TODO —— 通话按钮与通话浮层的截图将放这里。
> （把图片放进 `docs/screenshots/` 并在此节引用。）

## 环境要求

- Windows（DSH 桌面版）——安装脚本基于 PowerShell；插件本体与平台无关。
- Python **3.10+**（3.14 已验证；sherpa-onnx / edge-tts 均有当前版本的 wheel）。
- 安装时需要网络：PyPI（引擎）、GitHub Releases（语音识别模型，约 310 MB）、微软（edge-tts 每次合成）、你的 LLM provider。
- DSH 里已配置 OpenAI 兼容的 LLM provider（默认读取 volcengine / deepseek-v4-flash）。

## 安装

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File scripts\install.ps1          # 默认接 desktop profile
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile all
```

脚本会：

1. 把仓库同步到 `~/.dsh/plugins/dsh-voice-call`；
2. 创建 python venv 并安装 `sherpa-onnx` + `edge-tts`，下载中英双语识别模型（仅首次）；
3. 幂等地把 `dsh-voice-call` 写进 DSH profile 的 `dependencies` + `bundles`，并执行 `pnpm install`。

**重启 DSH 桌面应用**，输入框上方就会出现 **「🐋 语音通话」** 按钮。

> 手动接线（想自己改也行）：
> ```jsonc
> // ~/.dsh/profiles/<profile>/package.json
> "dependencies": { "dsh-voice-call": "file:../../plugins/dsh-voice-call" },
> "dsh": { "profile": { "bundles": [ ..., "dsh-voice-call" ] } }
> ```

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1              # 从 profile 摘除
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DeleteFiles # 连 ~/.dsh/plugins 的副本一起删
```

之后重启生效。

## 使用

1. 点输入框上方的 **🐋 语音通话** → 通话浮层打开，浏览器会请求麦克风权限（允许）。
2. 直接说话。停顿约 0.8 秒后，这句话会被识别并发出去。
3. 大黑鲸**开口回答**，屏幕同步显示字幕。
4. 她说话时**随时开口打断**，她会停下来听你说。
5. 🎤 静音，📞 挂断（挂断同时清空本次通话记忆）。

状态流转：`连接中 → 聆听中 → 思考中 → 说话中 → 聆听中 …`

## 配置

host 侧插件读取一个扁平配置对象，默认值如下（可通过 DSH 插件/设置层覆盖）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `enginePort` | `18765` | 本地 python 引擎端口 |
| `baseURL` | `https://ark.cn-beijing.volces.com/api/plan/v3` | LLM OpenAI 兼容地址 |
| `model` | `deepseek-v4-flash` | LLM 模型 id |
| `apiKeyEnv` | `VOLCENGINE_API_KEY` | 凭据引用名（经 `ctx.credentials` 解析） |
| `voice` | `zh-CN-XiaoxiaoNeural` | edge-tts 音色 |
| `rate` | `+0%` | edge-tts 语速 |
| `temperature` | `0.75` | LLM 温度 |
| `maxTokens` | `640` | LLM 最大输出 token |
| `maxHistory` | `16` | 每次通话保留的滚动消息条数 |
| `persona` | 鲸鱼娘人设 | system prompt，按喜好改 |

延迟说明：默认 provider 的模型首 token 通常 1–2 秒；按句合成再增加约 0.5–1 秒出第一句音频。想要更快，可在 DSH 设置里换延迟更低的 provider/model——插件跟随你配置的接口。

## 开发

```powershell
git clone https://github.com/<你>/dsh-voice-call
cd dsh-voice-call
powershell -ExecutionPolicy Bypass -File scripts\install.ps1   # 装进 DSH
node --check index.js && node --check client.js                # 语法检查
```

- Host 半区：`index.js` — cordis 插件，`/api/dsh-voice/*` 路由（`/status`、`/talk` SSE、`/interrupt`、`/reset`），引擎子进程生命周期。
- 客户端半区：`client.js` — `window.__ModuleLoader__` 模块，注入 `conversation.input.dock` 槽位；麦克风采集、VAD、WAV 编码、SSE、WebAudio 播放、打断。
- 引擎：`engine/server.py` — 纯标准库 HTTP 边车（`/health`、`/stt`、`/tts`）；`engine/requirements.txt`。
- 文档：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/PROGRESS.md](docs/PROGRESS.md)。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
