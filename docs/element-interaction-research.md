# 精确选取与即时元素编辑：技术核验和接入建议

核验日期：2026-10-31。范围：Athena 内置浏览器的元素选择、自然语言编辑、Google A2UI 控件面板。前五节为技术建议与源码核验；第 6 节记录实际实现、范围与延迟验收。

## 结论

采用 **DOM 精确引用 + 浏览器 AX 语义补全 + A2UI 官方 React renderer + 本地样式事务**。用户已经点选的元素，应由浏览器确定节点身份；模型负责理解意图与选择控件，连续拖动直接走本地预览链。

“零卡顿”不能由某个模型或新 API 保证。必须把模型往返移出拖动路径，并实际测量：输入、IPC、DOM 写入、浏览器合成、Athena 帧解码与呈现。只量工具返回时间不足以证明用户已看见变化。

当前可直接复用的 Athena 代码：

- `src/main/browser-page.ts`：开放 Shadow DOM 命中、文档内节点引用、节点移除失效、样式白名单、文本保护、预览及撤销。
- `src/main/browser.ts`：标签/iframe/文档作用域、坐标变换、可见页校验、`editInternal`、`detailsInternal`。
- `src/renderer/ElementInspector.tsx`：当前以文本输入、应用按钮为主；`ElementRef` 已携带 tab/frame/document/node 维度。

源码可见的优化机会：每次 `edit()` 均立即调用完整 `inspect()`，读取所有计算样式与祖先信息；主进程又发 outline、求 geometry、广播 selected 状态。若直接把 range 的每次 input 接到该流程，会放大排队与同步布局成本。需保留完整提交路径，同时增加有界、可合并的连续预览路径。

## 1. A2UI 当前版本与真实能力

官网当前将 **v0.9.1** 标为 production，v0.9 为 previous stable，v1.0 为 candidate。A2UI 是声明式 UI 协议：Agent 给出组件结构与数据，客户端使用自己信任的控件渲染。它不提供任意网页的元素识别、DOM 写入或源码修改能力。[官方版本表](https://a2ui.org/)

官方现有 React renderer，官网列出 v0.9.1 stable；不必再造完整 renderer。[Renderer 支持矩阵](https://a2ui.org/reference/renderers/)

本次核验上游 commit：`5e442ee31228c2fa72dec5b0372dd6242eb0995b`（2026-10-30）。npm registry 与该 commit 均给出 `@a2ui/react=0.14.0`、`@a2ui/web_core=0.14.0`；React peer 支持 18/19，适配 Athena 的 React 19。React 包 unpacked 851,779 bytes；web_core 为 7,672,776 bytes，均不是构建后 bundle 体积。web_core 带 Lit、Zod、Signals 等依赖，是否影响首屏应在构建后检查，必要时懒加载 Inspector。[React package](https://github.com/a2ui-project/a2ui/blob/5e442ee31228c2fa72dec5b0372dd6242eb0995b/typescript/renderers/react/package.json)、[npm React metadata](https://registry.npmjs.org/@a2ui/react/0.14.0)、[npm core metadata](https://registry.npmjs.org/@a2ui/web_core/0.14.0)

v0.9.1 使用 `createSurface`、`updateComponents`、`updateDataModel`、`deleteSurface` 四种消息。组件按 ID 组成平面列表，`root` 是入口；绑定使用 `{path:"/…"}`。输入先写本地 data model，默认不会逐次向 Agent 发请求；事件或显式 action 才回传。`sendDataModel` 也不表示每次滑动都联网。`action.functionCall` 可调用预注册的客户端函数，不是执行模型提供的 JavaScript。[v0.9.1 协议](https://a2ui.org/specification/v0.9.1-a2ui/)、[数据绑定](https://a2ui.org/concepts/data-binding/)

Basic Catalog 含 Slider、TextField、ChoicePicker 等，**没有 ColorPicker**。标准 Slider 支持数值 value/min/max，但该版 schema 没有 `step`；带步长、单位与数值框的属性编辑器应作为 Athena 自定义组件。v0_9_1 目录里的 basic catalog `$id`/`catalogId` 仍是 v0_9 路径，不能凭文档示例猜 URI。用固定 Athena catalog ID，并把实际 catalog schema 提供给 Agent。[已核对的 catalog 源码](https://github.com/a2ui-project/a2ui/blob/5e442ee31228c2fa72dec5b0372dd6242eb0995b/specification/v0_9_1/catalogs/basic/catalog.json)、[Catalog 机制](https://a2ui.org/concepts/catalogs/)

### 已核对的官方 API 接法

以下为接入示意，**未在 Athena 安装或执行**：

```tsx
import { A2uiSurface, createComponentImplementation } from '@a2ui/react/v0_9';
import { Catalog, CommonSchemas, MessageProcessor } from '@a2ui/web_core/v0_9';
import { z } from 'zod';

const colorApi = {
  name: 'ColorPicker',
  schema: z
    .object({
      label: z.string().max(40),
      property: z.enum(['color', 'background-color', 'border-color']),
      value: CommonSchemas.DynamicString,
    })
    .strict(),
};

// preview/commit must be host callbacks bound to the current selection.
const ColorPicker = createComponentImplementation(colorApi, ({ props }) => (
  <label>
    {props.label}
    <input
      type="color"
      value={props.value ?? '#000000'}
      onInput={(event) => {
        const value = event.currentTarget.value;
        props.setValue(value);
        preview(props.property, value);
      }}
      onBlur={() => commit()}
    />
  </label>
));
const catalog = new Catalog('athena:element-editor:v1', 'v0.9.1', [ColorPicker], []);
const processor = new MessageProcessor([catalog], handleAction, { version: 'v0.9.1' });
processor.processMessages([
  { version: 'v0.9.1', createSurface: { surfaceId: 'selection-42', catalogId: catalog.id } },
  {
    version: 'v0.9.1',
    updateComponents: {
      surfaceId: 'selection-42',
      components: [
        {
          id: 'root',
          component: 'ColorPicker',
          label: '背景颜色',
          property: 'background-color',
          value: { path: '/background' },
        },
      ],
    },
  },
  {
    version: 'v0.9.1',
    updateDataModel: { surfaceId: 'selection-42', value: { background: '#3355aa' } },
  },
]);
const surface = processor.model.surfacesMap.get('selection-42');
// Render only after the surface exists: <A2uiSurface surface={surface!} />
```

`v0_9` 是包的模块路径；实际 message schema 与版本兼容表明确接受 `v0.9.1`。`ComponentApi.schema` 不含 envelope 的 `id`、`component`；DynamicString/Number 会由 binder 注入 `setValue`。自定义容器应采用 `CommonSchemas.ChildList`，不要用普通字符串数组取代有 child-ref 标记的 schema。[版本支持](https://github.com/a2ui-project/a2ui/blob/5e442ee31228c2fa72dec5b0372dd6242eb0995b/typescript/core/web_core/src/processing/adapters/base.ts)、[消息 schema](https://github.com/a2ui-project/a2ui/blob/5e442ee31228c2fa72dec5b0372dd6242eb0995b/typescript/core/web_core/src/v0_9/schema/server-to-client.ts)、[React 官方用法与 binder](https://github.com/a2ui-project/a2ui/blob/5e442ee31228c2fa72dec5b0372dd6242eb0995b/typescript/renderers/react/README.md)

`surface.dataModel.subscribe(path, callback)` 返回可取消订阅；订阅时不立即回调初值，但 Agent 的 updateDataModel 与用户输入都会触发它。因此推荐直接在受信任组件的 input 处理函数里调用本地 preview，避免“Agent 刚生成面板就无意修改页面”。需要统一监听时增加来源标记；回读同步也不能再次触发预览。控件值改动无需 Agent、HTTP 或 MCP 往返。[DataModel 实现](https://github.com/a2ui-project/a2ui/blob/5e442ee31228c2fa72dec5b0372dd6242eb0995b/typescript/core/web_core/src/state/data-model.ts)

## 2. 精确位置与真实语义分开处理

**位置身份**继续绑定 `{tabId,frameId,documentId,nodeId/ref}`，可增加 `{backendNodeId,selectionRevision}` 作为浏览器侧锚点。CDP `DOM.getNodeForLocation` 返回命中节点的 backendNodeId 与 frameId；`DOM.resolveNode` 可取得节点对象用于精确检查。backendNodeId 不是跨导航永久 ID，也不能独立于所属 target/session 使用。[CDP DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)

**语义**选择后按需调用 `Accessibility.getPartialAXTree`，由浏览器提供 role、name、状态及 backendDOMNodeId。不要在 pointermove 上反复获取整棵 AX 树；全局 `Accessibility.enable` 会增加开销。语义补全应并行于面板首屏，不阻塞命中高亮。[CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)

识别顺序建议：浏览器 AX role → 有效 ARIA/原生标签 → 本地交互证据 → 模型辅助解释。`div role=button` 能识别为按钮；仅有 click handler、pointer cursor 或按钮外观的 div，浏览器可能仍给 generic。此时报告“推断为按钮”及证据，不能伪装成确定语义。事件委托还可能把 listener 放到祖先，`cursor:pointer` 也可能是装饰，单一规则不足。[WAI Button 语义](https://www.w3.org/WAI/ARIA/apg/patterns/button/)

点在按钮内的图标/span 时，应保留原始命中节点，同时提供最近的可交互祖先作为候选；用清晰的父级路径让用户切换。不要静默把选中的文字节点改成整个 card。选取的是“要改变外观的对象”，与“能触发相同动作的节点”也不完全相同。

**失败时关闭编辑能力**：导航、节点移除/替换、iframe detach、标签切换、旧 surface/revision 的操作均不得自动重定位到同 selector 新节点。只重新识别并让用户看见新选区；CSS selector 是说明和重新发现线索，不是当前节点身份。

本机元数据确认 Neo app 为 `0.51.2.3`；本次没有启动浏览器或实测新增 CDP/API。Tip-of-tree 文档不是该二进制的能力证明，接入须对实际 Neo 检查所用命令，并验证跨源 iframe/OOPIF、缩放、DPR 与 Shadow DOM。CDP 官方也不保证直接第三方使用的兼容性，固定 Neo 版本与针对性回归必不可少。[CDP 支持边界](https://chromedevtools.github.io/devtools-protocol/)

## 3. 两条交互路径，共用一个受约束编辑器

**自然语言**：选中后把精确 ref、语义与证据、computed styles、父级路径作为当前 turn 的选择上下文。Agent 产生已支持的 `ElementEdit`，或通过 `workbench_browser_controls` 请求面板。避免重新扫描整页、靠坐标或文字猜测已选元素。

**GUI**：选中即显示确定性默认面板；Agent 可以按用户意图调整组件组合、分组、范围、默认值。使用固定 Athena 样式与组件集；禁止 Agent 自行产生 HTML/CSS/脚本。颜色、数值、单位、枚举、间距、透明度、布局等组件由同一主题实现。面板生成不得迫使用户等待模型才能开始拖动。

建议 `workbench_browser_controls` 只允许当前选择的 ref 和受支持消息，宿主绑定 surfaceId/selectionRevision；限制组件数、层级、绑定路径、数值范围及允许 CSS 属性。不允许任意 catalog URL、任意本地函数、URL 控件或更换编辑目标。Agent 只发布控件；用户 input 才触发对应预览，独立的 Agent edit 仍走既有授权链。

### 连续预览的最小实现

1. 拖动开始：保存当前节点、文档版本及原始值；创建一个可撤销事务。
2. input：控件立即更新本地值；每帧合并同一属性的最新值，最多一个在途写入加一个待发送 patch。旧响应不得覆盖新值。
3. 页面：复用现有白名单校验和精确 ref；批量 `style.setProperty`。连续阶段只回少量 ack，不每帧读取全 computed/ancestor tree。
4. pointerup、keyboard commit、blur：flush 最后一笔；完整回读一次，产生一条撤销记录。color picker 原生弹层的 commit 时机需本机验证，不能只监听 pointerup。
5. 切页/失效：丢弃待发 patch 并终止事务；撤销不能覆盖网页在此期间独立更改的样式。

`requestAnimationFrame` 用于对齐合并与绘制，并非固定16ms计时器；后台页面可能暂停，因此最终 flush 不应仅依赖下一次 rAF。避免写 style 后同一循环反复读几何和 computed style。[HTML animation frames](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames)、[Chrome 布局性能](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)

CSS Typed OM 可减少数值字符串转换，但截至核验仍是 evolving draft，部分值/浏览器存在覆盖差异。它不是消除 IPC、截图传输和布局成本的捷径。优先保留兼容的 CSSOM `setProperty`，以真实 profiling 决定是否对数值路径增加 Typed OM，不能仅为追新重写样式引擎。[CSS Typed OM](https://drafts.css-houdini.org/css-typed-om/)、[CSSOM](https://drafts.csswg.org/cssom/#dom-cssstyledeclaration-setproperty)

WebMCP 当前官方资料显示处于 Origin Trial；适合由站点明确暴露业务动作。它要求网站配合，不能自动给任意第三方 div 补足语义，也不是现有网页样式编辑接口。作为未来对自有产品的增强，不作为本轮编辑的依赖。[Chrome WebMCP，2026-10-07 更新](https://developer.chrome.com/docs/ai/webmcp)、[实现状态](https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md)

## 4. 最新论文能借鉴什么

| 研究                                                                                                                  | 可用结论与本轮取舍                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [Probe to Act，2026-09-27](https://arxiv.org/abs/2609.33646)                                                          | 按需把 DOM 句柄映射到像素、把区域映射回候选节点；采用局部高亮/裁剪证据与动作前验证，不为已点选元素额外引入一次模型 grounding。  |
| [Trace2Ground，2026-10](https://aclanthology.org/2026.realm-1.100/)                                                   | 相同文字候选、上下文与结构关系是独立难点；选择上下文必须包含父级和位置关系，验收要有重复按钮。                                  |
| [IGG，2026-10-23](https://arxiv.org/abs/2610.32536)                                                                   | 目标可能先被遮挡、延迟出现或需 hover/scroll 才可见；不能把静态截图上的命中率当成真实交互可靠性。                                |
| [Right Click, Wrong Box，2026-10-27](https://arxiv.org/abs/2610.36831)                                                | 评估应看实际动作结果，不仅看坐标落框；Athena 需验证真正被改的是目标 DOM，未改同名邻居。样式编辑还需比点击动作更严格的节点边界。 |
| [InnerZoom，2026-06-29](https://arxiv.org/abs/2606.30084)、[RankGround，2026-09-16](https://arxiv.org/abs/2609.18690) | 通过单次前向或轻量区域筛选减少视觉 grounding 成本。适合未来 canvas/远程桌面无 DOM 场景；论文延迟改善不是本机 Mac 的运行证明。   |

这些属于研究证据，不是本轮已接入的模型。当前 browser 场景最有价值的是采用验证策略，而不是先下载训练模型或把每次 GUI 操作交给 VLM。

## 5. 必须量化的验收

下列是建议验收预算，**不是实测成绩**：选取点击至高亮 p95 ≤ 50ms；已有细节至默认控件可用 p95 ≤ 100ms；连续 input 至页面 DOM 写入 p95 ≤ 32ms；input 至 Athena 显示对应帧 p95 ≤ 100ms。记录 p50/p95/max、丢帧和 >50ms 长任务。若流媒体管线无法达到目标，应显式定位该段瓶颈，不能只显示乐观控件值掩盖页面延迟。

必要场景：

- 原生 button、`div role=button`、无 role 的事件委托 div、按钮内 SVG/文字、disabled 状态。
- 同文字/同 URL 多标签；滚动、缩放、DPR=2；开放 Shadow DOM、跨源 iframe、动态替换。
- 快速拖动 100 次只保留有限在途任务，最终值正确；一次撤销恢复原值；页面外部改样式后撤销冲突可见。
- 生成面板期间不修改网页；无 Agent 在线时默认滑块/颜色仍可实时操作；Agent 自然语言与 GUI 编辑结果彼此同步。
- 选择失效后旧 slider/colorpicker/Agent surface 不再写入；未知 catalog、超限组件、非法属性、恶意绑定路径被拒绝。
- 同时保存 DOM computed 值、目标/邻居对比截图和用户实际呈现时间；仅工具成功或数据 model 变化不算闭环。

本次仅修改本研究文档；没有安装依赖、启动测试浏览器、验证 A2UI 运行时或宣称零延迟。

## 6. 实现与验收（2026-10-31）

已实现，未发布。

- 官方 `@a2ui/react`/`@a2ui/web_core` 0.14.0 + v0.9.1 MessageProcessor；新增代码按需加载，构建产物约 307 KB / gzip 83 KB，不进入聊天首屏 chunk。
- Athena catalog 提供 ColorPicker、Slider、ChoicePicker、Column，覆盖颜色、排版、尺寸、四边间距、边框和布局。Agent 通过 `workbench_browser_controls` 提供受限的组件列表，宿主生成 A2UI surface/components/data 消息；没有实现或开放完整的任意 A2UI 消息执行器。
- UI 值采用官方本地双向绑定；用户 input 才调用预览。模型填入面板、回读与撤销同步不会自行改网页。
- 原有精确文档引用继续负责节点身份；按需用 `DOM.describeNode` 与 `Accessibility.getPartialAXTree` 补语义。在页面 world 解析同一 backendNodeId 后读取点击监听证据，单独标记 inferred。不会执行网站按钮来判断其类型。
- 样式连续写入有一个在途请求和一个最新值 patch；整次手势保留初始 cssText 并只占一个撤销位置。最后回读完整详情。写入/撤销时发现网站自己改样式，则拒绝覆盖。
- 仅交互期间立即确认帧，避免默认 24fps 节流增加拖动延迟；保持 DPR 2、原有帧尺寸和非交互节流。

### 实际证据

| 验收                 | 结果与文件                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全部基础测试         | `test-results/element-all-tests.txt`：126 项通过；随后补充的最新值合并/失效测试见下项                                                                                                             |
| 定位、语义、连续事务 | `test-results/element-controls-runtime.txt`：3 项通过；原生/ARIA 按钮、无 role 点击监听推断、普通 div 不误报；同名元素、同源/跨源 iframe、开放 Shadow DOM、节点替换、导航、外部样式冲突、单次撤销 |
| 实际 UI 与像素延迟   | `test-results/element-controls-ui.json`：60 次连续 input 合并为一笔撤销；12 次颜色变化对照已解码帧的实际像素，中位 27.8 ms，最慢 67.3 ms（本机隔离页面）；不是仅 IPC 耗时                         |
| 写入确认延迟         | 80 次写入，首次测量 P95 1.5 ms；并行回归期间 P95 5.7 ms / max 19.5 ms。包含本地主进程调用到页面 ACK，区别于帧呈现                                                                                 |
| 真实 Codex 两条路径  | `test-results/element-agent.json`：Agent 生成三个控件但未改页面，再按自然语言一次修改背景和圆角；同名元素未改变，无页面点击或 renderer 错误                                                       |
| 已有工作流           | `element-workbench.txt`、`element-selection.txt`：标签保留、查找选取、文本/渐变/动效、源码上下文、录制、停止与失败反馈通过                                                                        |

限制：不能保证任意高负载网站都零延迟；Canvas/WebGL 内部对象、closed shadow tree、页面自身长期阻塞主线程不是本轮支持的可编辑 DOM 目标。没有把 CSS selector 或推断的按钮语义当作新的节点身份。页面预览不保存源码。

### 依赖边界

`npm audit` 的剩余 high 来自上游 Zod 3 oversized collection 问题及派生项。输入已在进入 Zod 前被有界白名单校验，任意表达式/嵌套组件/网络控件未开放；此为缓解，非上游修复。DOMPurify 已固定 3.4.17；不会通过强行降级 A2UI 或更换不兼容 Zod major 来掩盖告警。参见 [Zod 公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。

打包首次启动已通过。安装包的像素测量曾发现首笔 248 ms，排查为上一笔撤销的成功扫光对颜色采样及真实颜色判断产生干扰。连续 GUI 预览开始即清除目标上的旧反馈层，提交不再叠加扫光；保留精确选框和控件状态，Agent 的执行反馈仍保留。最终打包测量以 `test-results/element-controls-packaged.json` 为准。

最终 0.3.0 安装包复测：`element-controls-packaged.json` 中 12 次输入到新像素呈现的中位数 **27.2 ms**、最大 **63.0 ms**；连续 60 次 input 仍为一笔撤销，renderer errors 为空。全新目录的 Neo 下载/校验/启动到 ready 与退出到 stopped 同时通过。最终样式 ACK 测量 80 次：P95 **2.84 ms**、最大 **4.00 ms**。本地 app `codesign --verify --deep --strict` 通过，采用 ad-hoc 签名，未公证、未对外发布。

## 7. 0.3.1 编辑工作区布局验收

元素检查器从 `BrowserPane` 移到 `App` 的左侧工作区，与对话切换，共用自然语言输入；浏览器视口不再容纳属性面板。外观、排版、布局控件分组，选取后的搜索入口收起，CSS 与定位仍可单独查看。

`test-results/inspector-layout.json` 实测：宽窗口打开编辑器前后，浏览器及原生帧均为 619×637；最小窗口为 519×478，切换视图不改变尺寸。350px 宽编辑区 scrollWidth=clientWidth，草稿、精确引用、编辑/撤销和源码交接通过。截图保存在 `inspector-layout-wide.png`、`inspector-layout-narrow.png`。原有工作流与选择反馈回归见 `inspector-layout-workbench.txt`、`inspector-layout-selection.txt`。
