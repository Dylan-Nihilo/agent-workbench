# Neo 原生能力接入核验

日期：2026-10-30。目标是让 Athena 的 Agent 直接使用 Neo 已有的网页执行、观察与会话能力，而非继续自行实现全部浏览器自动化。本文件保留实现前核验，并在第 9 节记录正式接入与验收；源码、安装与实测分别记录。

## 结论

建议采用：**现有 CodexSession 负责理解任务 → Athena 主进程负责任务授权、当前页面绑定和交互呈现 → Neo 官方 claw-server 执行网页工具并提供原生会话 API。**

Neo 不是只有一个 Chromium 可执行文件。已安装的 `BrowserOS neo.app` 内包含 Rust `browseros-claw-server` 和官方工具使用 skill。Athena 当前启动参数关闭了原生 server 和 extensions，因此此前主要复用了渲染引擎，尚未使用其完整 Agent 平台。

适合保留的 Athena 特有能力：同窗口 Retina 画面、等比输入校验、用户选取、受约束的样式/动画预览及撤销、源码修改入口。适合直接交给 Neo 的通用能力：AX snapshot、元素操作与批量填表、条件等待、settled diff、页面内容提取、文件传输、session 命名、原生审计与回放接口。

本轮不需要安装桌面 Computer Use 驱动，也不需要导入个人 Chrome 配置或改用户全局 MCP 配置来证明网页集成。

## 1. 版本与证据

| 对象                | 本次核验                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Athena 源码基线     | `083385e`，0.2.4；原有未提交上下文资料保留                                                                                                                    |
| 已安装 Neo app      | `CFBundleShortVersionString=0.51.2.3`；浏览器可执行文件位于同级 `browseros-runtime/BrowserOS neo.app`                                                         |
| 随包原生服务        | `Contents/Resources/BrowserClawServer/default/resources/bin/browseros-claw-server`；实际执行 `--version` 得到 `0.0.80`，`--help` 提供 `--config` 与 `--stdio` |
| 随包 skill          | `Contents/Resources/BrowserClawServer/default/resources/skills/browserclaw/SKILL.md`，包含原生 `snapshot → act → verify`、`run` 和等待规则                    |
| native app tag      | `browserclaw/v0.51.2.3` → `512f9cc15962b00b65b2cb35c429ed3134764f84`；该 tag 的 Cargo metadata 为 server 0.0.77，不能当作随包 0.0.80 的精确构建源码           |
| 0.0.80 源码参考     | `bbee9c963bd801643e5aa554855d8ff66f59fbdd` 的 Cargo metadata 为 0.0.80；这是匹配版本的公开参考，不冒充已证明的随包二进制 build SHA                            |
| 推荐新增官方 server | `claw-server/v0.0.90`，发布于 2026-10-30，`prerelease=false`，release target `b117de31d0bd63bd3d6795fe1cfb0acf1e344ce9`                                       |

原生 app、服务和扩展独立发布，必须分别记录版本。不能用 Chromium 版本代替 BrowserOS native 版本，也不能把 `main` 文档中所有新增 API 当作随包 0.0.80 已有功能。

来源：[仓库架构](https://github.com/browseros-ai/BrowserOS/blob/538ed33fd690eb40b961be9b000af069217d3c21/README.md)、[Neo app 源码 tag](https://github.com/browseros-ai/BrowserOS/tree/512f9cc15962b00b65b2cb35c429ed3134764f84)、[server 0.0.80 metadata](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/Cargo.toml)、[server 0.0.90 release](https://github.com/browseros-ai/BrowserOS/releases/tag/claw-server/v0.0.90)。

## 2. 应优先复用的原生工具

| 原生能力                                | 用途                                                | Athena 接入注意点                                                |
| --------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `snapshot` / `diff`                     | AX 树、`eN` 引用、变更回读                          | 不要把 Athena 自定义 DOM ref 与 Neo `eN` 混用                    |
| `act`                                   | 点击、输入、选择、键盘等；支持 `fields[]` 批量填表  | 复用原生输入和 settled diff，避免每一步再自写定位与固定 sleep    |
| `wait`                                  | 等待文字/selector/条件                              | 等可观察结果；不要把 elapsed time 当完成证明                     |
| `read` / `grep`                         | 页面 markdown 与局部检索                            | 优先有界提取，减少整页截图和长文本输入                           |
| `tabs` / `windows` / `history`          | 标签、窗口、导航状态                                | 精确绑定当前可见目标，不靠 URL 猜同名标签                        |
| `screenshot` / `pdf`                    | 视觉核验、页面归档                                  | 图片/归档属于模型输入或用户产物，需保留清晰的数据流向            |
| `download` / `upload`                   | 下载和上传                                          | 宿主仍需约束用户授权的文件与目标站点                             |
| `run`                                   | 在服务的 JS 沙箱中组合原生 SDK 调用，单次最多 30 秒 | 它不是 Node，也不是网页；但能经 SDK 操作页面，不能标成只读       |
| `name_session`、human help、session API | 原生任务名、人工协作、取消、记录                    | 与 Athena conversation/turn 建立映射，停止时调用真实原生取消链路 |

`run` 是官方优先批处理入口；沙箱没有 `fetch/require/process/document` 等 Node/页面全局。页面 DOM/API 访问必须经 `page.evaluate`。这不意味着 `run` 无副作用：SDK 还有 raw CDP、profile、credentials 等入口。模型侧权限不能只依赖提示词或顶层工具名称过滤。

来源：[0.0.80 原生 catalog](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/browseros-mcp/src/tools/mod.rs)、[0.0.80 run 契约与实现](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/browseros-mcp/src/tools/run.rs)、[官方连接说明](https://github.com/browseros-ai/BrowserOS/blob/538ed33fd690eb40b961be9b000af069217d3c21/docs/neo/mcp/index.mdx)。

## 3. 服务启动：stdio 可先验证，HTTP 需选安全版本

原生服务通过配置中的 CDP 端口直接连接浏览器，不依赖 dashboard 扩展才能执行基本网页工具。可让 Athena 保留自己启动的 Neo 与独立 profile，再启动对应官方服务；不必为了接通而修改用户的全局 Codex MCP 配置。

配置形状如下，所有路径和端口均应由宿主提供，不交给网页或模型随意指定：

```json
{
  "ports": { "server": 12345, "cdp": 12346 },
  "directories": { "resources": "/owned/native-server/resources" },
  "flags": { "devMode": true },
  "instance": { "browseros_version": "0.51.2.3" }
}
```

数字只是示意；实际 CDP 端口应来自 Athena 所启动 Neo 的 DevTools endpoint。使用独立 `BROWSERCLAW_DIR` 保存本应用的状态、记录和日志。可在该新目录预置 `analytics.json` 的 `{"enabled":false}`，避免集成时无意增加遥测；不要修改用户已有 Neo 状态。

`--config <path> --stdio` 使用 stdio MCP，不开放 HTTP API。HTTP 模式监听 `127.0.0.1`，同一服务同时提供 `/mcp` 与 JSON/session 接口。基本 MCP 使用不需要 dashboard 扩展；录制和人机交互的其他层必须另外验证。

**0.0.80 存在重要的全局副作用。** HTTP 启动会周期执行 `maintain_integrations`，它可能为已安装的 Agent 写入 MCP 和共享 skills。该版本仅设置 `devMode:true` 不足以阻断这条路径。其 owned `mcp-manager/connection-preferences.json` 可以让各 Agent 断开，但共享 `~/.agents/skills` 仍在 baseline roots 中，所以把所有 Agent 都 opt-out 也不是完整的无写入保证。

**0.0.90 的发布 tag 已修复这个集成边界：** `serve()` 在 `config.dev_mode` 为 true 时跳过自动 harness provisioning。若要单个 HTTP 服务复用原生 session、取消、人工协作和记录 API，应优先验证并固定这个官方版本，而不是给 0.0.80 造全局配置补丁。

不要同时启动两份服务共用一个状态目录。HTTP 启动回收“未结束的旧 session”时依赖端口独占；另开 HTTP 实例读取正在运行的 stdio 数据并不等同无害只读。

来源：[0.0.80 config](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/src/config.rs)、[0.0.80 启动](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/src/main.rs)、[周期 reconciliation](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/src/services/harness/reconciliation.rs)、[共享 skills roots](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/harness-integrations/src/skills/types.rs)、[0.0.90 发布源码](https://github.com/browseros-ai/BrowserOS/blob/claw-server/v0.0.90/packages/browseros-agent/apps/claw-server/src/main.rs)。

### 官方 0.0.90 资源

GitHub release 的公开 asset metadata 提供以下 SHA-256：

- [darwin-arm64 resources ZIP](https://github.com/browseros-ai/BrowserOS/releases/download/claw-server/v0.0.90/browseros-claw-server-rust-resources-darwin-arm64.zip)：`68f525da82433642ca03a39908826e2bc341ca2afa86bf9e10a864146b047396`
- [darwin-x64 resources ZIP](https://github.com/browseros-ai/BrowserOS/releases/download/claw-server/v0.0.90/browseros-claw-server-rust-resources-darwin-x64.zip)：`8183d518e7965d2dd6f08fbe8b03902a8fdf9bb82fc0f4f00a588fc2d3eb7b44`

官方 live alpha appcast 也列出 0.0.90 及 Ed25519 签名。GitHub 中的历史 stable appcast 文件仍可能指向较旧版本，因此不能把缓存文件当作当前发布事实。下载后需验证压缩包完整性、路径安全、metadata、binary `--version`；本研究没有安装该新组件。

保持已签名的 Neo `.app` 原样，不把新版 server 覆盖进它的资源目录。将原版资源放入 Athena 管理的版本目录，再通过明确路径启动。

## 4. 当前页面绑定：三种 ID 不能混用

Neo `page` 是服务进程本地的 `u32 PageId`，不是 CDP `targetId`，也不是 Chrome `tabId`。服务重启或目标重建后不能盲目复用旧映射。

0.0.80 的实际 `tabs active` 探针只返回文字，没有直接暴露完整 structured content。官方 SDK 提供可用于精确映射的可信宿主查询：

```javascript
return await browser.pages.list();
// 或 return await browser.pages.getInfo(pageId);
```

源码通过 `page_json` 返回 `pageId/targetId/tabId/windowId/...`。宿主应与当前画面对应的真实 CDP target 严格比对；不要按 URL、标题或列表顺序推断唯一对应关系。对于原生新建页面，也需要将结果映射回 Athena 的可见标签，避免 Agent 在另一页执行而用户看见旧画面。

可使用原生 `browser_target` 的 `set_window` 和 `strict:true` 绑定窗口；本次 run 捕获的 view 不会因为中途 target 变化自动放宽。需要实测 window/profile 绑定在 headless Neo 下的返回值和行为。

来源：[PageInfo 与 PageId](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/browseros-core/src/pages.rs)、[run pages.getInfo/list](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/browseros-mcp/src/tools/run.rs)、[browser_target](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/browseros-mcp/src/tools/browser_target.rs)。

## 5. 授权、取消与记录不是同一个问题

原生 bound-CDP 使用显式 method/parameter 规则，不是按域名字符串粗略放行；strict window 会阻止多种跨窗创建或移动。但这只是目标边界，不是用户操作授权。

0.0.80 的自由 `run` 同时有 typed `browser.credentials` 和 `browser.profiles({action:'load'})`；后者可加载其他已存在 profile，尽管它不会改变当前捕获的执行 view。没有发现通用的 server config/env capability allowlist 可把这些入口可靠删去。因此：

- 模型常用路径可直接复用原生 `act.fields`、snapshot、read、wait 等；宿主生成的可信 run 用于映射或已限定的批处理。
- 如果公开自由 run，要明确它是高级浏览器执行能力，不能因为藏了顶层 credentials 工具就称其已被禁用。
- 不应靠自行编写一套 JavaScript AST/CDP 代理来假装原生权限已完善；操作范围与确认仍由 Athena 负责。

HTTP `/mcp` 拒绝带 `Origin` 或 `sec-fetch-site` 的网页请求。应由主进程连接，不让 renderer 直接 fetch MCP。Loopback 限制也不等于认证或独立进程间授权。

原生 0.0.80 已有：

- `POST /api/v1/sessions/{session_id}/cancel`：取消 session 的原生 dispatch。
- `POST /api/v1/sessions/{session_id}/help/resolve`：可选 `{ "note": "..." }`，交还人工帮助。
- `GET /api/v1/sessions`、单 session、screenshots、recording 及 events 等读取接口。

宿主应绑定 Athena turn 和原生 session，点击停止或用户接管时同时停止原生执行，不能只停止模型输出。遇到执行结果未知，先核验当前页面，不重复提交。

来源：[原生 bound-CDP 策略](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/browseros-core/src/target/cdp_policy.rs)、[profile loading](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/crates/browseros-mcp/src/tools/browser_profiles.rs)、[HTTP middleware/路由](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/src/api/http/mod.rs)、[session取消与帮助](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/src/api/http/sessions.rs)。

## 6. 原生录像与回放分层复用

原生服务已有工具审计与截图；视频 capture 使用 `Page.startScreenRecording`。DOM/rrweb 回放则通过官方 `claw-app` recorder content script 和 relay 上传 document events。禁用扩展时，不能宣称完整 rrweb 回放已经工作。

0.0.90 新增的 `/api/v1/screencasts` WebSocket 可把多个 session 的画面复用在一条连接中；该 dashboard 路径为 low quality。Athena 可先保留已校准的 Retina 实时视图，接原生审计、取消及记录 API；若替换实时视图，需另验证清晰度、尺寸和输入映射，以及多个捕获会话不会互相抢占。

需要分别验证：工具调用已记入原生 session、截图/视频产物确实存在并可显示、rrweb document events 是否完整、用户输入与原生帮助是否归入正确会话。不能仅凭数据库有记录就宣布视频和回放成功。

来源：[原生视频 capture](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/src/services/capture/tab_capture.rs)、[官方 recorder](https://github.com/browseros-ai/BrowserOS/blob/538ed33fd690eb40b961be9b000af069217d3c21/packages/browseros-agent/apps/claw-app/entrypoints/recorder.content.ts)、[回放组装](https://github.com/browseros-ai/BrowserOS/blob/bbee9c963bd801643e5aa554855d8ff66f59fbdd/packages/browseros-agent/apps/claw-server/src/services/replay/builder.rs)、[多会话 screencasts](https://github.com/browseros-ai/BrowserOS/blob/538ed33fd690eb40b961be9b000af069217d3c21/packages/browseros-agent/apps/claw-server/src/api/http/screencasts.rs)。

## 7. 建议的验收证据

1. 在独立测试 profile 启动 Neo 和官方 server，列出实际 tools；记录 app/server/native capability 各自版本。
2. 证明 Agent 操作的是 Athena 当前可见页面，包括两个同 URL/标题标签时仍不串页。
3. 一条自然语言任务完成跨字段表单及页面状态改变，使用原生 act/wait/diff，并从实际页面读回结果。
4. 使用原生批处理和提取能力处理多条网页内容，记录模型往返和耗时；不能把固定延时动画当作加速证据。
5. 证明停止、用户接管、连接断开后不会继续排队动作；原生 session 的状态与 Athena 一致。
6. 检查原生审计/截图/回放各自的真实产物，并证明没有改用户全局 MCP/skills 或导入其他浏览器账号。

本研究只执行了安装包元数据、服务 `--help/--version` 及官方源码读取，没有启动浏览器或服务。主代理提供的隔离 stdio 探针已显示 0.0.80 可与 headless Neo 通信；后续 0.0.90 HTTP、操作闭环、取消和媒体产物必须由实际运行结果证明。

## 8. 许可证边界

BrowserOS/Neo 官方仓库为 AGPL-3.0。工程上优先使用未修改的官方组件、独立进程和公开协议，保留许可证、来源及版本信息，不把上游实现复制进 Athena 再宣称完全自有。若修改或重新分发组件，应核对相应源码和许可义务；独立进程通信也不构成对法律适用范围的保证。[官方 LICENSE](https://github.com/browseros-ai/BrowserOS/blob/main/LICENSE)

## 9. 正式接入验收（2026-10-31）

已接入 `neo-server.ts → neo-browser.ts → main.ts → CodexSession`，固定官方 0.0.90，校验下载 SHA-256 和安装 metadata。界面显示连接状态、重新连接、每轮网页任务执行记录，并把真实 session ID 关联到聊天。通用任务采用 Neo 原生工具；Athena 继续处理选中元素、可撤销外观预览和输入画面。

- `test-results/neo-all-tests.txt`：124 项通过，包括原有 CLI、选择、编辑与浏览器回归。
- `test-results/neo-electron.txt`：真实 Electron + Neo 页面显示、输入、选取和录制通过，无 renderer 错误。
- `tests/neo.test.ts`：两个相同网址/标题的标签按 targetId 精确绑定；整表批量填充、真实本地服务器保存、读取结果、停止前后对照、拒绝高级脚本及人工协作交还。
- `test-results/neo-live.json`、`neo-live.png`：真实 Codex 在 Athena 界面接收自然语言任务，调用 snapshot → act.fields → act.click → read，服务端核验 `{title:"Athena 发布",owner:"Ada"}`，session 状态 done，执行记录可见，无 renderer 错误。

人工协作测试发现 native request 会等待用户，已改为与宿主提示并行，释放浏览器输入队列；确认后调用真实 help/resolve，再交回控制权。停止时取消原生 session；取消接口失败会终止自有 worker，阻止不确定的后台脚本继续运行。

边界：目前验收的是原生工具审计，不等同录像或 rrweb 回放；没有修改 Neo app、全局 MCP 或其他浏览器 profile。未发布或推送。

首次安装的补充验收：独立打包 app 使用全新测试目录及现有 Neo 浏览器路径，成功从官方 release 下载并校验 0.0.90，解压后补 executable bit（ditto 实际输出为 0644），启动原生服务进入 ready。下载使用 Electron `net.fetch` 的系统网络栈；本机 Node fetch 对 release asset 超时，而系统网络栈成功。错误后保持可见错误状态，不再因普通 browser state 广播触发反复下载。官方网络行为见 [Electron net](https://www.electronjs.org/docs/latest/api/net)。
