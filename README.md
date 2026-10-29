<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 QQ Bot 插件，将 DeepSeek AI 助手接入 QQ 私聊与群聊。**

[![npm version](https://img.shields.io/npm/v/@tencent-connect/dsh-qqbot)](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tencent-connect/dsh-qqbot)](https://github.com/tencent-connect/dsh-qqbot)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[English](./README_EN.md) | 简体中文**

扫码加入 QQ 群 / 频道

<table>
<tr>
<td align="center" width="50%"><img src="./assets/docs/qqgroup.jpg" height="360" alt="QQ 群二维码" /><br /><b>QQ 开发者交流群</b><br /><sub>1群: 1032635674 · 2群: 1056948758</sub></td>
<td align="center" width="50%"><img src="./assets/docs/qqchannel.jpg" height="360" alt="QQ 频道二维码" /><br /><b>QQ 开发者社区频道</b><br /><sub>频道号: 20dnumts4z</sub></td>
</tr>
</table>

</div>

## 架构

```
QQ 用户 → QQ WebSocket → dsh-qqbot → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## 安装

### 方式一：桌面版安装（推荐）

无需命令行，全程在应用内完成：

1. **安装**：左侧栏点击「插件」→「添加插件」→ 输入 `@tencent-connect/dsh-qqbot@latest` → 安装并立即启动

<img src="./assets/docs/install.png" alt="端内添加插件" width="560" />

2. **连接**：左下角头像 → 设置 →「QQ 机器人」→ 手机 QQ 扫码连接

<img src="./assets/docs/setting.png" alt="设置页扫码连接" width="560" />

扫码成功后凭据自动保存，后续启动无需再次扫码。

### 方式二：手动执行

```bash
# 安装到 profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# 启动
npx @deepseek-ai/dsh --profile qqbot
```

首次启动时，插件检测到凭据未配置会自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。

无端内绑定页的环境（如纯 CLI）可设置 `QQBOT_BIND_OPEN_BROWSER=1`，额外拉起系统浏览器扫码页作为降级通道。

<img src="./assets/docs/qrcode.png" alt="二维码扫码示意图" width="280" />

> **提示**：建议升级至 `0.4.0` 以上版本扫码，支持点击链接在浏览器打开，避免部分终端二维码渲染错位的问题。

### 方式三：本地路径安装

```bash
# 构建
cd /path/to/dsh-qqbot
pnpm install && pnpm build

# 安装到 profile（本地路径）
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot

# 启动
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### 方式四：--patch 开发模式

```bash
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | **必填** | QQ Bot AppID（或通过 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | **必填** | QQ Bot AppSecret（或通过 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商名称 |
| `model` | string | `deepseek-chat` | 模型名称 |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent 工作目录 |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 才触发 |
| `groupPrompt` | string | - | 群聊额外 system prompt |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `streaming` | boolean | `true` | 是否启用流式输出（群聊始终不启用） |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时(ms)，默认 30 分钟 |
| `processingTimeoutMs` | number | `1800000` | 处理超时(ms)，超时中断当前 LLM 调用 |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `historyLimit` | number | `10` | 群历史缓冲条数 |
| `askTimeoutMs` | number | `300000` | 待答问题超时(ms)，默认 5 分钟（ask_user_question） |
| `showToolResults` | boolean | `false` | 是否展示工具调用成功结果（错误始终展示） |
| `debug` | boolean | `false` | 调试模式 |

### 访问控制（access）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | 私聊访问模式 |
| `access.c2cAllow` | string[] | `[]` | 私聊白名单（user openid） |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | 群聊访问模式 |
| `access.groupAllow` | string[] | `[]` | 群聊白名单（group openid） |

### 富媒体理解（media）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | 是否启用富媒体理解（图片/视频下载 + 工具分析） |
| `media.maxMB` | number | `200` | 富媒体下载大小上限(MB) |
| `media.ttlHours` | number | `24` | 富媒体存活时长(小时)，0=永不过期 |

### 视觉理解（vision）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | 是否启用视觉理解（qqbot_describe_image 工具） |
| `vision.provider` | string | - | 视觉模型 provider（如 pi-ai） |
| `vision.model` | string | - | 视觉模型 id（如 qwen-vl-max） |
| `vision.maxBytes` | number | `10MB` | 图片字节上限 |
| `vision.maxTokens` | number | `1024` | 输出 token 上限 |
| `vision.timeoutMs` | number | `120000` | 视觉调用超时(ms) |

### 附件发送（sendFile）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | 是否启用路径白名单（仅 media + cwd + extraRoots） |
| `sendFile.extraRoots` | string[] | `[]` | 额外允许访问的根目录 |

## 内置命令

| 命令 | 说明 |
|------|------|
| `/list` | 列出宿主会话（序号 / 标题 / 目录 / 运行中），点击序号即可绑定 |
| `/list-all [n]` | 同上，按最近活跃排序取前 n 条（默认 50，上限 200） |
| `/use <序号\|ID前缀> [提示词]` | 把当前 QQ 会话绑定到某个宿主会话，可顺带投递一句提示词 |
| `/current` | 查看当前绑定与目标会话状态 |
| `/unuse` | 解除绑定，回到插件私有会话 |
| `/new [--dir <绝对路径>] [标题]` | 新建宿主会话并绑定（均已绑定时）；未绑定且无参数时等价于重置当前会话 |
| `/status [序号]` | 查看绑定会话（或指定序号会话）的详细状态 |
| `/watch [序号\|ID前缀]` | 订阅某个会话的输出（只收转发、不接管输入；不带参数订阅当前绑定） |
| `/unwatch [序号\|ID前缀]` | 取消订阅（不带参数清空全部） |
| `/search <关键词>` | 按标题 / 工作目录 / ID 搜索会话，结果可直接 `/use <序号>` |
| `/summary [序号\|ID前缀]` | 查看会话最近几轮问答（不带参数看当前绑定） |
| `/reset`（别名 `/clear`） | 重置当前插件会话（清空上下文） |
| `/compact` | 压缩会话历史（摘要替换旧记录，保留上下文） |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset（新会话生效） |
| `/stop` | 中止当前生成 |
| `/bot-ping` | 网络延迟检测（返回传输与处理耗时） |
| `/bot-version` | 查看版本信息 |
| `/bot-status` | 查看当前会话状态 |
| `/bot-help` | 查看所有指令 |

## 会话绑定（宿主会话同步）

默认情况下每个 QQ 会话对应插件内的一个私有 agent 会话，与桌面版 / Web 里的会话互不相通。
**会话绑定**把某个 QQ 会话（单聊按 openid、群聊按 group_openid）指向一个**宿主会话**，
两边从此是同一个会话：

- QQ 发来的消息直接投递进目标会话（`sessionController.prompt`），不再创建私有 agent；
- 目标会话每轮结束时，把 assistant 的文本回复转发回 QQ；
- 桌面版 / Web 里的操作（切换模型、发消息、看结果）与 QQ 侧看到的是同一份上下文。

### 前提

需要 profile 里同时具备 `@deepseek-ai/dsh-web-app`（提供 `sessionController`）。
只装 `dsh-base` 时绑定能力不可用，`/list` 会明确提示而不是静默失败。

插件通过 `ctx.inject(['sessionController'], …)` 探测该能力：服务晚于插件注册也能拿到，
控制台会打印一次 `[im-qqbot] 会话绑定已启用（sessionController 可用）` 作为部署自检。

### 典型流程

```
/list                  → 看到桌面版里的会话列表
/use 3                 → 绑定第 3 个会话（也可 /use a1b2c3d4 用 ID 前缀）
/current               → 确认绑定
（在 QQ 里直接聊，回复会同步回桌面版会话）
/unuse                 → 解除，回到插件私有会话
```

### 实现要点

| 事项 | 说明 |
|------|------|
| 绑定落盘 | `~/.dsh-qqbot/bindings.json`，按 `qqbot:<appId>:<scope>:<peerId>` 存 sessionId，进程重启后仍有效 |
| 入站 | `handleInbound` 前置分流：有绑定且能力可用 → `bridge.prompt()`，失败回一句 `⚠️ 投递到绑定会话失败：…` |
| 出站 | 监听 `session/event` 的 `turn/end`，取本轮 `assistant/message` 文本转发；插件私有会话不参与转发 |
| 中继保真度 | 按轮转发纯文本（无流式增量、无工具卡片、无附件）——刻意收窄，避免与流式出站路径互相干扰 |

## 核心模块

```
src/
├── index.ts                    # Cordis 插件入口（async apply）
├── config.ts                   # 配置 Schema
├── types.ts                    # 全局类型定义
├── setup/                      # 凭据绑定（扫码）
│   ├── index.ts                # 绑定编排（ensureCredentials）
│   ├── binding-service.ts      # 扫码状态机（宿主内唯一事实源）
│   ├── bind-routes.ts          # 端内绑定页路由（/qqbot/im-qqbot/bind）
│   ├── presenters.ts           # 呈现策略（终端/浏览器降级）
│   ├── qr-svg.ts               # 二维码 SVG 渲染（宿主侧）
│   └── persist.ts              # 凭据写入 cordis.patch.yml
├── client/                     # 浏览器半边（dsh.client Web Bundle）
│   ├── index.ts                # 侧栏 Tab 注册 + 待绑定自动引导
│   └── bind-page.ts             # 端内绑定页（二维码 + 状态轮询）
├── bridge/                     # 宿主会话绑定（/list /use 等）
│   ├── binding-store.ts        # peerKey → sessionId 落盘
│   ├── session-bridge.ts       # 能力探测 + 列表/解析/投递/中继
│   └── index.ts                # 模块出口
├── gateway/                    # 网关装配
│   ├── bootstrap.ts            # 启动装配（监听 session/event 等）
│   └── middleware-setup.ts     # 中间件链配置
├── transport/                  # 传输层
│   ├── inbound.ts              # QQ 入站消息 → 绑定会话 prompt / agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # 流式缓冲
│   ├── streaming-writer.ts     # 流式写入
│   ├── reply-target.ts         # 回复目标解析
│   ├── msgid-cache.ts          # 被动回复 msgid 缓存
│   ├── reply-limiter.ts        # 被动回复限流
│   ├── tool-presenter.ts       # 工具调用展示
│   └── chunker.ts              # Markdown 文本切分
├── session/                    # 会话管理层
│   ├── session-manager.ts      # QQ peer → Agent 映射
│   └── idle-evictor.ts         # 闲置回收
├── model/                      # 模型路由层
│   ├── model-resolver.ts       # 路由解析
│   ├── prefs-store.ts          # per-peer 偏好持久化
│   └── settings-reader.ts      # settings.yaml 只读
├── features/                   # 交互特性
│   ├── question-channel.ts     # ask_user_question 问答通道
│   ├── approval-channel.ts     # approval 审批确认通道
│   └── answer-parser.ts        # 答案解析
├── media/                      # 多媒体
│   ├── vision-tool.ts          # 图片视觉理解
│   ├── send-file-tool.ts       # 发送本地文件
│   └── media-cleaner.ts        # 媒体 TTL 清理
├── middleware/                 # 中间件
│   ├── question-answer.ts      # 问答答案处理
│   └── attachment.ts           # 附件处理
├── shared/                     # 共享工具
│   ├── utils.ts                # 通用函数
│   ├── scope.ts                # scope/peer 提取
│   └── send-helper.ts          # 分块发送
├── commands/                   # 斜杠命令
│   └── bridge.ts               # /list /use /current /unuse /new /status
```

## 会话路由

sessionKey: `qqbot:${appId}:${scope}:${peerId}`，新会话铸造 UUID 会话 id 并持久化到 `model-prefs.json`，重启后按持久化 id 恢复；0.5.x 老会话按原派生 id 沿用。

**绑定优先**：`/use` 建立绑定后，该 peer 的消息不再走上述派生会话，而是投递到绑定的宿主会话（见上一节）。

解析策略：进程内复用 → 持久化恢复 → 全新创建。

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh "Plugins, not loop changes" 原则
- **声明式依赖** — `inject = ['agents']`，不直接耦合其他插件
- **会话隔离** — 每个 QQ 私聊用户/群聊各一个独立 Agent
- **Preset 支持** — 可通过 `agent-presets` 服务挂载预设（工具集、prompt 等）
- **闲置回收** — 超时自动 dispose Agent，防止内存泄漏
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块/表格感知切分
- **图片理解** — 支持 `qqbot_describe_image` 视觉理解，可分析用户发送的图片
- **附件发送** — 支持 `qqbot_send_file` 将本地文件发送给用户（默认启用路径白名单）
- **问答互动** — 支持 `ask_user_question`，单选生成内联按钮（点一个其余变灰）、多选回复编号，逐题推进 + 问题级超时
- **操作确认** — 支持 `approval/request`，关键操作通过「允许/拒绝」按钮请求用户确认

## 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 开发模式（watch）
pnpm dev

# 用 --patch 方式调试
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## License

[MIT](./LICENSE)
