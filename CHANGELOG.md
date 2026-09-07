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

[1.0.0]: https://github.com/MoDaoZiWangLin/dsh-voice-call/releases/tag/v1.0.0
