# dsh-voice-call — DSH 语音通话插件（比肩原生）

状态：v1.0.0 完成（代码/引擎/安装脚本齐备，已接线 desktop profile，待重启验证）
日期：2026-09-07

## 目标
公子要求：DSH 里做 GPT/豆包式语音通话，「比肩原生的效果」。
- 麦克风说话 → 大黑鲸语音回答（DeepSeek 同款模型 + 鲸鱼娘人设）
- 低延迟、流式播放、说话打断、状态切换、好看的通话 UI

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
