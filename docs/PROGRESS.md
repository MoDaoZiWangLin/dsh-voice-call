# dsh-voice-call — DSH 语音通话插件（比肩原生）

状态：✅ **v1.0.0 全链路打通，公子验收 Perfect（2026-09-08）**。剩余改进留待下次新对话。
日期：2026-09-07（开发）→ 2026-09-08（验收）

## 当前能力（全部实测）
- 麦克风说话 → SenseVoice 本地识别（中英日韩粤自动检测、标点、数字 ITN）
- → 火山引擎 deepseek-v4-flash 流式回复（鲸鱼娘人设、滚动历史）
- → edge-tts 合成（晓晓音色）→ 整句 mp3 一次性推送 → HTMLAudioElement 原生播放
- 连贯自然、语序正确（TTS promise 链串行保序）、说话打断（300ms 语音）、静音/挂断
- 黑匣子 diag：client 事件 + host 句级 TTS 字节，落盘 diag.log，排查靠它

## 交付物
- GitHub：https://github.com/MoDaoZiWangLin/dsh-voice-call （main，tag v1.0.0，Release v1.0.0）
- 仓库：C:\Users\MrTim\dsh-workspace\dsh-voice-call
- 运行副本：~/.dsh/plugins/dsh-voice-call（引擎 venv+模型）、profiles/desktop/node_modules/dsh-voice-call
- 测试：`npm run smoke`（cordis 加载模拟）、`node scripts/e2e-test.mjs`（真实 STT→LLM→TTS→音频+语序断言，需在 DSH 环境跑）

## 改动流程（下次会话照做）
1. 改代码（仓库）
2. robocopy 仓库→plugins（XD .git/.venv/models）+ 复制 index.js/client.js/server.py 到 node_modules 副本
3. `node --check` ×2 + `python -m py_compile` + smoke + e2e
4. git commit + push（-c http.proxy= -c https.proxy= 直连；Clash 代理常掉）
5. 重启 DSH（`powershell -File C:\Users\MrTim\dsh-workspace\restart-dsh.ps1`，延迟 15s 自动重启）

## 下次新对话待办（公子确认的改进方向）
- [ ] 句间平滑衔接（每句播放边界 ~50-100ms gap 微优化，可用 WebAudio 双 buffer 无缝）
- [ ] 可配置化：schemastery `Config` schema（音色/语速/模型/provider/阈值），接入设置面板
- [ ] 音色可选：zh-CN-XiaoxiaoNeural 之外加 Yunxi/晓伊 等，或本地 kokoro/piper 离线 TTS
- [ ] 长回复流式化：当前整句合成完再推，可做"边合成边播+保序"（按句内 mp3 分块带 seq）
- [ ] barge-in 灵敏度按用户习惯微调（SPEECH_RMS 0.015 / BARGE_HITS 3）
- [ ] 通话转录/历史导出
- [ ] README 补截图（docs/screenshots/ 占位已建）
- [ ] 发 v1.0.1 tag + Release

## 关键坑（务必先读，防重踩）
- 插件/client 改动**必须重启 DSH 才生效**（无 dev:web 时）；重启后 profile 里 bundle 必须在（wire-profile）
- node_modules 副本会落后 → host 的 server.py/venv 解析绑定 plugins 源目录（ENGINE_ROOT 推导）
- `ctx.credentials.resolve(ref)` 返回 `{value, source}` 对象，不是字符串
- mp3 必须**整句**收齐再播（分块播=电音）；TTS 必须**串行保序**（并行=语序乱）
- Electron：AudioContext 需手势 resume；播放用 HTMLAudioElement（decodeAudioData 解不了 mp3）
- Windows PowerShell 5.1 读 .ps1 要 UTF-8 BOM；package.json scripts 不能叫 install（pnpm 11 拦）
- 运行中 App 锁 node_modules 原生模块 → 运行中 pnpm install 会 EPERM；全量重装等重启后

## 已实现（全部本地验证过）
- [x] 引擎：venv 装 sherpa-onnx 1.13.7 + edge-tts 7.2.8 + numpy（Python 3.14 wheel 齐全）
- [x] ASR 模型：sherpa-onnx-zipformer-zh-en-2023-11-22（int8 编码器），实测 0.wav → 620ms
- [x] TTS：edge-tts 晓晓音色，国内直连可用，25 字句子 ~1s / 27KB mp3，流式
- [x] LLM：火山引擎 ark / deepseek-v4-flash 流式首 token ~2s（OpenAI 兼容）
- [x] host index.js：路由 /status /talk(SSE) /interrupt /reset + 引擎生命周期 + 打断
- [x] client.js：通话按钮 + 全屏浮层 + 麦克风 VAD + WAV 编码 + SSE 播放 + barge-in
- [x] git 项目化：README 中英、LICENSE(MIT)、.gitignore、install/uninstall、wire-profile、
      ARCHITECTURE.md、CI(语法检查)
- [x] 已接线 desktop profile（file:../../plugins/dsh-voice-call + bundles + pnpm install）

## 待验证（需要重启 DSH 后）
- [ ] 插件加载：输入框上方出现 🐋 语音通话按钮
- [ ] 通话浮层 + 麦克风权限（Electron 默认行为）
- [ ] 完整语音回路：说话 → 识别 → 回答 → 播放 → 打断

## 架构速记
浏览器(client.js) ──HTTP/SSE──► host(index.js) ──loopback──► python(server.py)
- client: getUserMedia → ScriptProcessor(4096) → 16k 抽取 → VAD(100ms/RMS≥0.010/静音800ms/上限12s)
  → WAV(PCM16) → POST /talk → SSE audio 帧 → decodeAudioData → 队列播放；说话打断 POST /interrupt
- host: 守卫=loopback socket+Host+browser marker；LLM=直连 provider OpenAI 兼容流式，
  key 经 ctx.credentials.resolve(credentialRef(apiKeyEnv))；按句切分(。！？!?\n, 36字符兜底)
- engine: ThreadingHTTPServer, /health /stt /tts；edge-tts 逐请求线程泵流

## 配置默认值
baseURL=https://ark.cn-beijing.volces.com/api/plan/v3, model=deepseek-v4-flash,
apiKeyEnv=VOLCENGINE_API_KEY, voice=zh-CN-XiaoxiaoNeural, rate=+0%,
temperature=0.75, maxTokens=640, maxHistory=16, enginePort=18765

## 坑（供后续维护）
- 桌面 webserver 403 一切非浏览器请求（desktopBrowserAccess），curl 抓不了 GUI。
- sherpa-onnx OfflineRecognizer 没有 enable_endpoint_detection 参数（那是流式 API 的）。
- venv 里 numpy 要显式装（sherpa-onnx 不拉它）。
- 插件/客户端改动必须重启 DSH 生效（plugin-manager 明示"下次重启生效"）。
- Windows PowerShell 5.1 读无 BOM 的 UTF-8 .ps1 会乱码 → 脚本必须带 UTF-8 BOM。
- package.json 的 scripts 不能叫 install（npm 生命周期钩子，pnpm 11 严格策略会拦）。
- pnpm file: 依赖会拷贝插件到 node_modules，但丢弃点目录(.venv)和未列入 files 的大目录(models)
  → host 端必须跨目录解析引擎资源（candidateRoots: 自身→~/.dsh/plugins→工作区）。
- 运行中的 App 会锁住 node_modules 里的原生模块(lightningcss)，运行中 pnpm install 会 EPERM；
  全量重装需等重启后。删 .modules.yaml 会触发全量 reimport，别在 App 运行中干。
- LLM 首 token ~2s 是 provider 侧延迟；要更快换低延迟 provider/model。
- 麦克风权限：Electron 无显式 permission handler，行为待实测；客户端已优雅处理 NotAllowedError。
