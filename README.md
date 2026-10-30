# Agent Workbench

运行在 Mac 上的本地 AI 工作台，界面简称 Workbench。使用本机 Codex 执行任务，在同一窗口的 BrowserOS neo 侧栏中浏览多个页面、精准选取 DOM 元素、预览文字与样式修改、录制操作，或把元素上下文交给 CLI 修改当前项目源码。

0.2.0 采用中性灰与冷蓝色界面，支持面板、侧栏与弹层过渡，以及系统减少动态效果设置。本轮重点是本机 CLI 和浏览器；保留已有飞书功能，未扩展其接入范围。

![Workbench 工作区](docs/screenshots/workspace.png)

本仓库公开可见，项目代码保持 `UNLICENSED`，尚未授予开源许可证。当前接通的是 **Codex**；Claude Code、OpenCode、Gemini CLI 仅检测安装情况，尚不能在本应用执行任务。

## 启动

需要 macOS、Node.js 22.12 或更高版本、npm，以及可正常登录的 Codex CLI。

在 `agent-workbench` 仓库根目录执行：

```bash
npm ci
npm run setup:browseros
npm run dev
```

`setup:browseros` 使用项目内的 `scripts/setup-browseros.mjs` 获取并校验官方 BrowserOS neo，默认放在仓库相邻的 `../browseros-runtime/BrowserOS neo.app`。脚本不启动浏览器，也不写入 `/Applications`。已有安装可以在「设置与连接 → 浏览器」选择 `BrowserOS neo.app`；应用会尝试发现 `/Applications`、用户 `Applications` 及项目相邻的 `browseros-runtime`。不会把普通 Chrome 当作 BrowserOS neo。

如果尚未安装 Codex，可使用官方 npm 包，然后完成官方登录：

```bash
npm install -g @openai/codex
codex login
codex login status
```

登录完成后，在 Workbench 的「本机 Agent」设置中刷新检测。Workbench 复用该 CLI 的现有登录，不要求把 Codex 密钥粘贴到本应用。安装与登录方式以 [Codex 官方说明](https://github.com/openai/codex#quickstart) 为准；模型调用使用对应账户的配额或计费。

构建后启动和生成本机应用目录：

```bash
npm run build
npm start

# 生成本机 macOS app，采用 ad-hoc 签名，尚未公证
npm run package
```

应用位于 `release/` 下，对应名称为 `Agent Workbench.app`。当前打包配置使用 ad-hoc 签名，没有 Apple Developer ID 签名、公证或自动更新，不代表已完成对外发布。

## 体验一次完整流程

1. 在设置中选择真实项目目录，确认 Codex 已登录。点击右上角「浏览器」，在地址栏输入任意受支持的 HTTP(S) 地址。
2. 用标签栏的 `+` / `⌘T` 新建页面；点击标签切换，`⌘W` 关闭活动标签，`⌘L` 定位地址栏。各标签保留独立页面和历史；页面弹出的新窗口也进入标签栏。
3. 点击「选取元素」，再点击页面的文字、图片或控件；也可打开元素检查器，按文字或唯一 CSS 选择器查找。检查器展示层级、定位信息、文字和计算样式，选取本身不会点击目标按钮。
4. 修改内容或样式后点击「应用预览」，在页面中即时查看，并可逐次撤销。预览只改变当前 DOM，刷新后恢复。含复杂子节点或敏感内容的元素不会被文字编辑破坏，可以选择其具体文字节点或调整允许的样式。
5. 点击「修改源码」，把标签、frame、稳定元素引用、选择器和累计预览改动附加到聊天。确认要求后发送；CLI 会先核对页面与项目的对应关系，再定位组件、请求必要审批、修改文件并验证。任意远端网站不会自动对应到本机源码。
6. 点击「录制」，完成一段跨页面操作后结束。记录包含标签/frame 身份、精确元素目标、编辑与撤销步骤，可导出 JSON，并交给 Agent 分析目标、步骤、参数与待确认预期。

命令、文件写入或额外权限请求需要时在 Workbench 桌面界面确认。聊天中的停止按钮可中止当前 Agent 任务；直接操作网页或人工切换标签也会接管浏览器，阻止排队的 Agent 操作继续执行。

浏览器工具升级时，Codex 协议不能直接修改旧线程的工具集合。Workbench 保留完整界面对话和旧线程 ID，将已保存的可见历史传给一个明确标记的新执行会话；不会把未更新的旧工具伪装成新版本。CLI 进程退出后，下次请求会从保存的执行会话重新建立连接。

## 浏览器怎样运行

Electron 负责聊天、设置和同窗口的浏览器侧栏；实际网页由官方 BrowserOS neo 原生引擎以 **DPR 2（Retina）** 渲染。Workbench 通过本机 CDP 将实时页面帧流嵌入右侧面板，并把鼠标、键盘、中文输入和滚动转发到该页面。

neo 作为独立后台进程以 headless 模式运行，**不会打开独立浏览器窗口**。用户始终在 Workbench 的同一窗口内操作网页；这不是把 Electron 自带 Chromium 标成 neo，也不只是静态截图。DPR 2 是页面渲染设置，输入坐标按 CSS 像素映射。

演示使用独立浏览器 profile，并关闭 neo 的 server、updater、extensions 等 sidecars。Workbench 自己提供这一版的浏览器工具；不启动 neo 内置 Agent/MCP 服务，不替换或导入现有 Chrome 配置。退出 Workbench 会结束其管理的浏览器进程。

每个标签都有独立 CDP 状态，只有活动标签输出画面。元素引用同时绑定标签、frame、文档和本次激活状态；导航或切换后，旧引用会拒绝执行，避免同名元素或旧坐标落到另一个页面。帧流按原比例显示，窗口和检查器调整大小期间不会沿两个轴拉伸页面，尺寸未同步时不接受坐标点击。

元素工具已验证普通 DOM、开放的 Shadow DOM，以及普通同源和跨源 iframe；旋转或 3D 变换的 iframe 会拒绝精确坐标操作。closed Shadow DOM 的内部节点、Canvas/WebGL 内部绘制对象不会被当作可定位的 DOM 元素。文件上传下载、页面原生对话框、浏览器扩展及所有网站兼容性仍有范围限制；页面对话框目前会被关闭并写入诊断。

## 飞书

在「设置与连接 → 飞书」点击「创建专用机器人」，用飞书扫码并确认新建。看到“连接已建立”后，向新机器人私聊发送桌面显示的 `绑定 WB-…`，完成操作者配对。

配对后，私聊任务即可在本机运行并回复结果；同一飞书会话在同一工作目录下复用对话。发送 `/cancel`、`停止` 或 `取消` 可请求停止。需要审批时，仍需回到 Mac 确认。

连接并配对期间，桌面发起的任务也会发送飞书通知：Agent 本轮回复结束、执行失败，以及等待回答或操作审批。结构化提问会展示问题和选项；被 CLI 标记为敏感的问题只提示回到桌面填写，审批通知不发送完整命令或权限载荷。回答与审批继续在 Workbench 内完成，不接受飞书消息作为批准指令。普通文本提问随本轮回复通知，不通过问号猜测任务状态。

同一请求只通知一次，已解决或停止的待发送提醒会被丢弃；飞书发起的任务保留一条最终回复。通知投递失败不会把已完成的任务改成失败。断线期间不保存通知队列，恢复连接后也不补发过期审批提醒。

Mac 必须保持开机、联网、Workbench 运行。没有云端代跑；关闭应用或机器睡眠后，不承诺离线消息补发。只处理已配对操作者的原始单聊文本，以及富文本消息中的可见文字；不读取附件。详细步骤和权限见 [飞书连接指南](docs/feishu-setup.md)。

**已实机验证飞书扫码创建、真实长连接、配对，以及系统授权后的加密配置恢复。飞书触发 Agent 操作并回传结果的最终联调仍在确认。**

## 数据与凭据

- 设置、聊天和操作记录保存在 Electron `userData` 的 `workspace.json`；这些普通工作区数据不是加密数据库。
- 飞书 App Secret、操作者绑定和持久消息 inbox 通过 Electron `safeStorage` 加密后保存；密钥由 macOS 系统密钥存储保护，连接状态不会携带 App Secret。扫码取得的凭据留在主进程；手动输入框在保存成功后清空。加密能力不可用时，不发起机器人创建。
- Codex 登录仍由官方 CLI 管理。浏览器 profile 与普通聊天/录制不属于上述飞书加密范围；演示建议使用测试账号。
- 录制会遮罩识别出的敏感输入字段，但并非全站数据脱敏。检查导出的 JSON、页面文字和截图后再分享；Agent 获取的上下文会进入你选用的模型服务。
- 不要将凭据、浏览器 profile、消息 inbox 或真实用户数据提交到 Git。用 `WORKBENCH_USER_DATA_DIR` 指定自定义数据目录时，应将它放在仓库之外。

## 验证与已知范围

```bash
npm run typecheck
npm test

# 隔离的提问/审批界面与 IPC 联调；使用测试 CLI，不调用模型或飞书
npm run build
npx tsx tests/attention.e2e.ts

# 多标签、元素检查器、预览/撤销、源码上下文及录制的真实 Electron 联调
# 使用隔离页面与测试 CLI，不写真实项目
npx tsx tests/workbench.e2e.ts

# 显式运行真实 Codex + BrowserOS neo 集成检查，会产生模型调用
npx tsx tests/live-agent.e2e.ts
```

测试覆盖 CLI 协议、浏览器行为和飞书持久化/配对/去重。真实 BrowserOS neo 与 Codex 的网页操作、录制分析链路已有本地验证；这不代表所有网站均兼容。飞书测试不创建真实应用、不发送真实消息。

0.2.0 已用真实本机 Codex 验证工具升级后的会话延续、精确文件变更审批和 HTML 源码落盘，再用全新 BrowserOS 实例加载该文件确认结果。页面预览与源码修改是两条独立验证链路。

0.1.1 的通知逻辑、超时/去重及提问与审批界面已通过自动化验证；真实 Codex 默认模式的结构化提问→测试回答→继续完成也已验证。该能力仅在 Workbench 启动的进程中开启，不修改全局 CLI 配置。向真实飞书会话的通知投递仍待实机确认。

操作理解目前产出分析和 JSON 记录，**尚未实现**一键生成完整 Playwright 回归用例、PRD 覆盖率报告或后端状态复原。当前只有供本机使用的 ad-hoc 签名打包，Developer ID 签名、公证、自动更新和对外发布尚未完成。

第三方组件与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

更新后的本地签名可能触发 macOS 钥匙串授权。应用会显示恢复进度；超时后保留原配置，并提供“重试恢复连接”。请由用户本人处理系统授权，不需要重新创建机器人。
