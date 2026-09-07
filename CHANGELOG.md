# Changelog

本项目的所有显著变更都会记录在此文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-07

### Added

- **语音通话 UI**：输入框上方「🐋 语音通话」悬浮按钮 + 全屏通话浮层（头像状态灯、实时波形、状态文案、字幕、静音、挂断）。
- **麦克风采集与语音活动检测（VAD）**：`getUserMedia` + ScriptProcessor 降采样至 16 kHz 单声道；按 100 ms 分块计算 RMS，静音 800 ms 封口一句话，12 s 硬上限。
- **本地离线语音识别（STT）**：sherpa-onnx 中英双语 zipformer 模型（int8 编码器），纯本地运行，音频不出本机。
- **流式语音合成（TTS）**：edge-tts，默认晓晓音色（`zh-CN-XiaoxiaoNeural`），按句合成、边生成边推送。
- **流式 LLM 回答**：OpenAI 兼容接口直连 DSH 已配置的 provider（默认火山引擎 `deepseek-v4-flash`），鲸鱼娘「大黑鲸」通话人设，滚动历史（默认保留 16 条消息）。
- **说话打断（barge-in）**：大黑鲸说话或思考时开口，立即停止播放并中止生成，转入聆听。
- **Host 路由**：`GET /status`、`POST /talk`（SSE 事件流）、`POST /interrupt`、`POST /reset`，带 loopback + 同源浏览器标记守卫。
- **引擎生命周期管理**：插件加载时自动拉起 Python 边车，健康检查、崩溃重启、卸载时清理。
- **跨目录资源解析**：host 从 `node_modules` 副本加载时，自动在 `~/.dsh/plugins/dsh-voice-call` 与开发目录间解析 venv / 模型路径。
- **安装与卸载脚本**：`scripts/install.ps1` / `scripts/uninstall.ps1`（幂等接线 DSH profile、同步插件目录、搭建 Python 环境、下载模型）。
- **文档与工程化**：README（中英双语）、架构文档、开发进度文档、CI（语法检查）、MIT License。

### Security

- 所有路由仅接受 loopback 回环地址 + 本机 Host + 浏览器同源标记；浏览器端与引擎之间不直接通信，全部经 host 编排。
- LLM API 密钥通过 DSH `ctx.credentials` 服务解析，插件不落盘、不打印凭据。

### Fixed

- 补上 `dsh.bundle.patch` 清单字段与 `cordis.patch.yml`——缺少它时桌面端启动会报
  `profile bundle "dsh-voice-call" declares no dsh.bundle in its package.json` 并拒绝加载。
- 移除普通对象形式的 `Config` 导出——cordis 会把插件的 `Config` 导出当作 Standard Schema
  调用 `Config["~standard"].validate`，普通对象会抛 `Cannot read properties of undefined (reading 'validate')`
  并导致插件树加载失败；改为模块私有默认值，schema 化配置留待后续。
- 新增 `scripts/smoke-load.mjs` 冒烟测试：模拟 cordis 的 `resolveConfig` 分支 + 用最小 ctx
  真实执行 `apply()`（`npm run smoke`，需在 DSH 环境内运行）。
- 修正麦克风 VAD 灵敏度：说话阈值 `0.010 → 0.004`（低增益麦克风也能触发），
  增加连续 2 个分块才开启录音的噪声门（防单次噪声误触发），静音判定用更低下限避免切断软尾音；
  通话浮层新增实时音量诊断条（`🎤 RMS · 状态 · 阈值`），并强化 AudioContext 被挂起时的自动恢复。
- 修复 LLM 凭据解析：`ctx.credentials.resolve()` 返回的是 `{value, source}` 对象而非字符串，
  原代码按字符串解包导致恒报「找不到 VOLCENGINE_API_KEY 凭据」——现在正确读取 `result.value`。
- 识别模型升级为 **SenseVoice**（`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`）：
  中文准确率大幅提升，支持中/英/日/韩/粤自动检测、标点与数字 ITN（如「9 点」），
  原双语 zipformer 保留为 fallback；引擎按 `models` 根目录自动选择最优模型。
- 麦克风降采样由抽取式改为线性插值（抗混叠），提升识别精度。
- 修复引擎加载到过期副本的问题：`engine/server.py` 与 venv 绑定解析（永远来自
  `~/.dsh/plugins` 源安装目录），不再可能命中 `node_modules` 里的旧副本——
  旧副本不认识 `DSH_VOICE_MODELS_ROOT`，导致模型加载失败、`ensureEngine` 空等 25 秒。
- VAD 再校准：说话阈值 `0.004 → 0.015`、静音下限 `0.002 → 0.008`（桌面环境底噪实测
  在 0.004~0.01，0.004 会频繁误触发）；barge-in 改为需要连续 300ms 语音才打断，
  环境噪声不再可能中断大黑鲸的回答。

[1.0.0]: https://github.com/MoDaoZiWangLin/dsh-voice-call/releases/tag/v1.0.0
