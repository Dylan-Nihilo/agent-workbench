# 页面直接编辑方案调研

核验日期：2026-10-30。架构基线：Workbench `9a2b521`；浏览器实测：BrowserOS neo / Chromium `155.0.8314.26`。本报告区分官方能力、对本项目的适配判断，以及已完成的本机探针；没有安装下列编辑器，也没有将其宣称为已集成。

## 结论

**当前最适合的是继续完善 CDP 驱动的页面选择与可撤销预览；下一步为受控本地项目增加 React Grab 的源码上下文适配。** 如果以后独立建设“用注册组件搭页面”的产品，再优先评估 Puck。

没有找到能同时做到“接管任意现有网页、保留网站状态、直接编辑、可靠写回任意框架源码”且可直接嵌入当前架构的成熟通用组件。成熟方案分别解决选择、高亮、组件编排或源码定位；源码写回仍需明确的项目对应关系和验证流程。这是对下列接口与当前代码的适配判断，不是对所有产品的穷尽结论。

## 当前架构决定了什么

- Electron 的 `BrowserPane` 显示 BrowserOS neo 推送的 JPEG 帧，将鼠标、键盘和滚动传回 CDP。React renderer 并不拥有目标网页中的按钮或文字 DOM。
- `BrowserRuntime` 在目标 frame 的 isolated world 安装页面桥接；元素引用绑定 tab、frame、document 与激活状态。当前文字/样式/动效预览由桥接执行，支持撤销；源码修改另经本机 CLI。
- 因此，把一个 React 编辑器装在 Workbench renderer 中，只会接触本地 UI 或那张页面图片。要直接控制远端网页元素，仍须在目标文档运行适配层，或使用 CDP 的 DOM/Overlay 接口。完整编辑器不自动消除这层工作。

代码依据：[BrowserPane](https://github.com/Dylan-Nihilo/agent-workbench/blob/9a2b521/src/renderer/BrowserPane.tsx)、[BrowserRuntime](https://github.com/Dylan-Nihilo/agent-workbench/blob/9a2b521/src/main/browser.ts)、[页面桥接](https://github.com/Dylan-Nihilo/agent-workbench/blob/9a2b521/src/main/browser-page.ts)、[检查器与源码请求](https://github.com/Dylan-Nihilo/agent-workbench/blob/9a2b521/src/renderer/ElementInspector.tsx)。

## 候选比较

| 方案                              | 已有能力与许可                                                                                                                                                                                                                                            | 与 Workbench 的适配判断                                                                                                                                    | 建议                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Chromium CDP Overlay**          | 原生悬停检查、节点高亮、盒模型和选择事件；协议仓库 BSD-3-Clause，Overlay 域仍标为 experimental。[协议源码](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Overlay.pdl)                                                       | 与现有 CDP 通道直接兼容；不需要迁移网页到编辑器的数据模型。它解决选取和高亮，不负责文字编辑、撤销、AI 或源码写回。                                         | 最成熟的底层选择参考；本机探针已证实基本可用。可逐步用于盒模型/原生节点诊断，不必为了本次 hover 重写现有编辑内核。 |
| **React Grab**                    | 悬停选择后提取元素、组件堆栈与源码位置；MIT；`react-grab/primitives` 提供结构化上下文和命中检测。[README](https://github.com/aidenybai/react-grab)、[primitives](https://github.com/aidenybai/react-grab/blob/main/packages/react-grab/src/primitives.ts) | 很适合“本地开发页面 → CLI 修改组件”这一步。需要在目标应用中接入；在 Workbench renderer 安装不会读到 neo 的 React Fiber。任意远端网站可能没有可用源码信息。 | 下一阶段首选适配器，仅用于明确关联的本地开发项目；复用上下文提取，保留 Workbench 交互和审批。                      |
| **React Dev Inspector**           | 点击 React 元素跳转本地 IDE；MIT。官方流程包含页面 Inspector、开发服务器中间件和开发时源码信息。[官方仓库](https://github.com/zthxxx/react-dev-inspector)                                                                                                 | 适合定位源码；不负责把拖动、样式或自然语言改动回写源码。需要应用/开发服务器接入。                                                                          | “打开对应文件”的轻量备选；如已采用 React Grab，不必重复引入。                                                      |
| **Puck**                          | 注册 React 组件、字段配置、拖放、数据持久化、inline text、可定制 hover/selected overlay；MIT。[集成模型](https://github.com/puckeditor/puck)、[inline text 与 overlay](https://puckeditor.com/blog/puck-020)                                              | UI 模式与需求接近，但编辑对象是其 `config + data` 渲染的组件，不是任意正在运行的第三方网页。适合我们控制组件和数据的场景。                                 | 如增加独立页面搭建器，优先评估；当前浏览器编辑器无需迁移到 Puck。                                                  |
| **GrapesJS Core**                 | HTML/CSS 模板、组件模型、样式面板、层级、存储、富文本；Core 为 BSD 三条款许可。[组件模型](https://grapesjs.com/docs/modules/Components.html)、[Core LICENSE](https://github.com/GrapesJS/grapesjs/blob/dev/packages/core/LICENSE)                         | 导入 HTML 会被解析为它的组件模型和画布；不能据此承诺保留原网站 React 状态、监听器、路由或登录流程。                                                        | 更适合邮件、静态页面、模板编辑。Core 与商业 Studio SDK 要分开判断许可和费用。                                      |
| **Moveable + Selecto**            | 拖动、缩放、旋转、吸附与框选；均 MIT。[Moveable](https://github.com/daybrush/moveable)、[Selecto](https://github.com/daybrush/selecto)                                                                                                                    | 需要真实 DOM target，须注入目标文档或做远端几何适配。不会把自由移动自动转成正确的 flex/grid/响应式源码；Selecto 的普通矩形命中也有旋转对象限制。           | 仅在明确需要多选、拉伸或自由画布时再评估；为本轮 hover 引入收益有限。                                              |
| **Builder Content Visual Editor** | SDK 接入后注册自有组件与可编辑 inputs，再在可视化编辑器使用。[官方接入文档](https://www.builder.io/c/docs/custom-components-setup)                                                                                                                        | 是另一套内容/组件编辑工作流，需要接入目标应用及其服务；不等于可嵌入任意现有网页的通用编辑内核。                                                            | 可参考用户交互；本轮没有新增 SaaS、账号或订阅。此处结论仅针对 Content 文档，不混同 Builder Code 产品。             |

## 维护状态快照

下表来自当日官方 GitHub API 的仓库和 release 元数据；`pushed_at` 只是仓库活动信号，不能单独证明质量、兼容性或长期维护承诺。未把星数当成熟度依据。

| 项目                | 查询到的最近仓库 push | 查询到的 GitHub release                                                   | 判断                                                  |
| ------------------- | --------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| React Grab          | 2026-08-22            | `@react-grab/cli@0.2.0`，2026-08-16；仓库中的 `react-grab` 包也标 `0.2.0` | 有近期开发和性能/浏览器测试；仍是 0.x，需锁版本验证。 |
| React Dev Inspector | 2026-04-20            | `/releases/latest` 返回 404                                               | 有近期仓库活动；404 不等于没有 npm 版本。             |
| Puck                | 2026-10-29            | `v0.24.0`，2026-10-29                                                     | 持续演进，适合受控组件编辑器。                        |
| GrapesJS            | 2026-10-21            | `v0.23.8`，2026-10-15                                                     | 持续演进，适合模板工作流。                            |
| Moveable            | 2024-06-03            | `0.53.0`，2023-12-03                                                      | 功能积累充分，近期维护信号弱；接入前重新验证。        |
| Selecto             | 2024-06-17            | `1.26.3`，2023-12-03                                                      | 同上，不应称为当前持续活跃项目。                      |

元数据来源：[React Grab](https://api.github.com/repos/aidenybai/react-grab)、[React Grab release](https://api.github.com/repos/aidenybai/react-grab/releases/latest)、[包信息](https://github.com/aidenybai/react-grab/blob/main/packages/react-grab/package.json)、[React Dev Inspector](https://api.github.com/repos/zthxxx/react-dev-inspector)、[Puck](https://api.github.com/repos/puckeditor/puck)、[Puck release](https://github.com/puckeditor/puck/releases/tag/v0.24.0)、[GrapesJS](https://api.github.com/repos/GrapesJS/grapesjs)、[GrapesJS release](https://github.com/GrapesJS/grapesjs/releases/tag/v0.23.8)、[Moveable](https://api.github.com/repos/daybrush/moveable)、[Moveable release](https://github.com/daybrush/moveable/releases/tag/0.53.0)、[Selecto](https://api.github.com/repos/daybrush/selecto)、[Selecto release](https://github.com/daybrush/selecto/releases/tag/1.26.3)。

## CDP Overlay 本机可行性探针

在隔离本地页面使用项目实际 `BrowserRuntime`，开启原生 `DOM`/`Overlay`，调用 `highlightNode` 与 `setInspectMode`。没有访问用户当前网站、账号或浏览器 profile，也没有更改应用依赖。

已观察到：

1. 600×400 CSS viewport、DPR 2 下，节点高亮出现在 1200×800 的 JPEG 帧流与 PNG 截图中，目视位置正确；因此“原生 Overlay 不能进入现有画面流”的假设不成立。
2. `searchForNode` 模式收到 `inspectNodeRequested`，隔离按钮的普通网站 click 计数保持 0。
3. 退出时该版本需要传 `{ mode: 'none', highlightConfig: {} }`；省略 `highlightConfig` 实测返回错误。这说明仍需版本适配，不能只照最新协议描述直接替换。

本机证据保存在忽略目录 `test-results/overlay-research/`，包含 `runtime-probe.ts`、`runtime-result.json`、`runtime-highlight.jpg` 与 `runtime-screenshot.png`。这只证明当前 neo 的基本高亮/点击可用；未以此证明跨源 iframe、导航、Esc、popup、缩放、所有系统的完整接入。协议源码另注明 `highlightRect` 有 DPR 已知问题；本探针使用的是 `highlightNode`。

## 对下一步实现的建议

### 现在：改善任意网页上的选择与预览

保留现有精准元素引用、撤销和录制链路。选择模式使用浅色 hover 边界、稳定的 selected 边界和简短元素标签；点击选取不触发网站动作。滚动、布局变化、切页和失效元素均更新或清除反馈。轻量效果放在独立覆盖层，避免为显示“正在处理”修改网站的原始 transform、opacity 或已有动画。

AI 请求携带已选元素的必要上下文和允许修改的属性，避免为了已知目标重复全页截图与查找；反馈与工具真实状态绑定，不能用固定延时伪装完成。减少模型轮次、减少 CDP 往返、减少上下文体积分别计量；动画只改善感受，不应作为模型推理加速的证据。

### 然后：原位文字与紧邻元素的操作栏

建议提供“改文字 / 样式 / 交给 AI / 撤销”的紧邻元素操作入口。简单文字字段可在 Workbench 的目标位置显示原位输入控件，提交仍调用现有 `editElement`，使用一个 patch 完成一次可撤销修改。这样可复用现有权限、敏感字段、复杂子树保护和输入处理。

如改用目标页 `contenteditable`，必须处理 React 重渲染、IME 组合输入、粘贴 HTML、焦点、Escape、失效引用与撤销；不要全页开启 `designMode`。复杂段落、富文本或组件 children 的结构编辑应进入明确支持的数据模型。Puck 的 inline text 可以作为交互参考，但其字段模型不是任意 DOM 的替代层。

### 再后：让本地开发页准确回到源码

首选对明确关联的本地 React 项目接入 React Grab primitives，提取组件名、文件、行列与 DOM 信息；将经校验的结果作为现有“修改源码”请求的额外证据。其源码显示命中检测覆盖开放 Shadow DOM 和同源 iframe；跨源 iframe 仍应沿用 Workbench 的 CDP frame 路由。源码位置可能为空，应保留普通 DOM 上下文回退，不根据网页声称的路径直接写文件。[结构化接口](https://github.com/aidenybai/react-grab/blob/main/packages/react-grab/src/primitives.ts)

本地适配器需要允许列表、工作区路径约束、绑定当前 tab/document，以及页面与工作目录的对应验证。不要为了选择元素默认冻结整站 React 更新或已有动画；React Grab 的 freeze 是另一项可选能力。

“预览看起来正确”与“源码修改正确”须分别验收：预览可撤销；源码应定位组件、展示 diff、跑必要检查，再通过热更新或重载重新观察。Chrome 官方 Workspace 文档也明确，Elements 面板的 DOM 修改不会自动保存到源文件；本地资源映射与 source maps 不能被省略。[Chrome Workspace](https://developer.chrome.com/docs/devtools/workspaces)

## 验收与尚未证明的部分

- 本轮研究没有引入第三方依赖；CDP 探针不等于已替换产品中的选择器。
- React Grab 的官方“2× faster”是其自身宣称，本报告没有复现，不把它用作 Workbench 的性能承诺。
- 未来接入前必须锁具体包版本、保留相应 MIT/BSD 通知，并验证项目实际 React 版本、iframe、Shadow DOM、CSP、输入法及 reduced motion。
- 任意外部网页的页面预览不会自动变为对方服务器上的持久修改；源码落盘仅适用于已确认并授权的本地项目。
