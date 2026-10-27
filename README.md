# milkdown-chunk-editor

[English](./README.en.md) | [简体中文](./README.md)

面向大文档的 Milkdown 富文本编辑器:**按标题分片 + 视口虚拟化**,只为可视区域挂载编辑器实例。

## 为什么需要它

ProseMirror 会为文档中**每一个节点**创建一个 DOM 元素并保持同步。文档越大,每次按键要做的 DOM 校验和重绘越多,输入延迟随节点数线性增长。ProseMirror 作者 marijn 在[官方论坛](https://discuss.prosemirror.net/t/different-parsing-strategy-for-large-documents/1017)明确表态:大文档虚拟化 out of scope,不打算进核心库,并建议「每个 chapter 一个 ProseMirror 实例」。

本包正是这个思路的实现:

1. **文档层** — 按 H1/H2 把 markdown 切成 chunk,含代码围栏状态机(围栏内的 `#` 不是标题)
2. **视口层** — 自维护 prefix-sum 高度表 + 二分查找可见区间,只挂载 overscan 范围内的独立 Editor 实例
3. **渲染层** — `content-visibility: auto` 让已挂载但屏外的 DOM 跳过 layout / paint

> 注意:`@milkdown/plugin-virtual-scroll`、`crepe.configure({ virtualization })` 等 API **并不存在**。
> 网上相关教程给出的都是虚构代码,请勿照抄。

## 浏览器兼容性

包本身**不依赖任何 Node 内置模块**,产物是纯 ESM,可在浏览器 / WebView / Tauri 中直接运行。

关于 `Node.fromJSON` —— 这里的 `Node` 是 **ProseMirror 的 Node 类**(`prosemirror-model`),
不是 Node.js。它是纯 JS 实现,不碰 `process` / `Buffer` / `require`,浏览器里完全可用。

已用真实 Chromium 验证(esbuild 打包 + Playwright 运行):

```
无 process / require / Buffer        ✓
Node.fromJSON 路径可用                ✓
ProseMirror 真实渲染                 ✓
content-visibility 生效               ✓
虚拟滚动正常(40 块文档只挂载 5 个)    ✓
产物零 Node 内置模块引用              ✓
```

运行 `npm run test:browser` 可复现。

### WebView 注意事项

- `content-visibility: auto` 需要 **Chrome 85+ / Safari 18+**。更老的 WebView 会忽略它 ——
  只是失去绘制优化,功能不受影响。
- 首次挂载需要解析 markdown,大文档建议配合 `disableCache: false`(默认)复用缓存。

## 安装

```bash
npm i milkdown-chunk-editor
# peer dependency
npm i @milkdown/kit
```

### 仅支持 ESM

`@milkdown/kit` 的 `exports` 只声明了 `import` 条件,没有 `require`,因此本包也**不提供 CJS 产物**。
在 CommonJS 环境里请用动态 `import()`:

```js
const { ChunkedEditor } = await import('milkdown-chunk-editor')
```

打包工具(Vite / webpack / Rollup)不受影响。

## 使用

```ts
import { ChunkedEditor } from 'milkdown-chunk-editor'
import 'milkdown-chunk-editor/style.css'

const editor = new ChunkedEditor({
  scroller: document.getElementById('scroller')!,
  content: markdown,
  splitLevel: 2,      // 1=按 H1 切(章节)  2=按 H1/H2 切(小节,默认)
  overscan: 1,        // 视口外额外挂载的屏数
  onSave: (md) => persist(md),
  onOutline: (items) => renderSidebar(items),
})

await editor.mount()

// 大纲点击
editor.scrollToChunk('chunk-12', 'center')

// 全文导出(会自动 flush 所有已挂载实例)
const full = editor.getMarkdown()

// 卸载
editor.destroy()
```

### HTML 结构

滚动容器必须有确定高度,包会自动补 `position: relative`:

```html
<div id="scroller" style="height: 100vh; overflow-y: auto"></div>
```

## 性能

### 实测数据

单块 3000 字符的转换成本(Node 环境):

| 操作 | 耗时 |
|---|---|
| remark parse(冷路径) | 5.4 ms |
| remark stringify | 8.7 ms |
| `Node.fromJSON`(缓存命中) | 0.006 ms |
| 内容指纹计算 | ~0.002 ms |
| 创建 Editor 实例 | ~3.6 ms |

端到端滚动开销(真实 Chromium,40 块文档,60 步,独立页面交替顺序取中位数):

| 配置 | ms/步 | 相对基线 |
|---|---|---|
| 无任何优化 | 2.32 ms | — |
| 仅 doc JSON 缓存 | 0.59 ms | **3.9x** |
| 仅实例复用 | 1.44 ms | 1.6x |
| 仅 dirty 标记 | 0.16 ms | **14.9x** |
| 三项全开 | **0.15 ms** | **15.4x** |

> **测量方法很重要**:不要在测试里 `await requestAnimationFrame()` ——
> rAF 按 60fps 节流,等帧测出的是【帧间隔】(16.7ms)而非实际开销,会得出完全错误的结论。
> 正确做法是 `scrollTop = x; await editor.sync()`,不同步等帧;
> 并且每种配置用独立页面测量、交替顺序跑多轮取中位数,消除 JIT 与 GC 干扰。

### 五项关键优化

**1. dirty 标记 —— 收益最大的一项(14.9x)**

卸载块时无条件调 `remark stringify` 是最大的浪费:用户只是滚了一下,内容根本没变。
现在只有 `tr.docChanged` 触发时才置 dirty,未修改的块直接跳过序列化。

专项测量(派生一个去掉 dirty 检查的变体对比):**2.315 ms/步 → 0.155 ms/步**。

> 实现细节:没有使用 `@milkdown/plugin-listener` 的 `updated` 回调 —— 它内部有 200ms
> debounce,且用 `prevDoc.eq(doc)` 判断变化,导致「内容是否被改过」这个信号本身就延迟。
> 本包直接挂 ProseMirror 插件监听 `tr.docChanged`,立即触发且语义精确。

**2. doc JSON 缓存 —— 消除重复的 parse(2.4x)**

块的 markdown 内容和上次挂载时相同,就没必要重新解析。
用 FNV-1a 内容指纹判断是否变化,命中则直接注入 `{ type: 'json' }`,
Milkdown 走 `Node.fromJSON` 路径 —— 3000 字符块上从 5.4ms 降到 0.006ms。

缓存按 LRU 淘汰,默认上限 32MB(可用 `cacheBytes` 调整)。

**3. sync 去重 + 并行挂载**

滚动事件与 `ResizeObserver` 都会触发同步,若不加保护,同一块会被挂载两个实例
(内存翻倍且内容互相覆盖)。现在有重入保护 + in-flight 去重,并行挂载所有待加载块。

**4. 高度表:Fenwick Tree**

高度表原本是「数组前缀和 + 二分查找」,更新一块高度要 O(n) 全量重算。
改成树状数组后,单次更新降到 O(log n):

| 块数 | 旧实现(单次更新) | 新实现 | 加速比 |
|---|---|---|---|
| 100 | 0.22 μs | 0.19 μs | 1.2x |
| 1 000 | 6.04 μs | 0.23 μs | 26x |
| 10 000 | 44.7 μs | 0.14 μs | 319x |
| 100 000 | 933 μs | 0.31 μs | 2985x |

**但要说清楚:日常文档规模用不上。** 实测 80 块时,布局计算只占滚动耗时的 0.01%,
被浏览器渲染开销完全淹没。要到约 3.5 万块,Fenwick 的优势才会占到滚动耗时的 5% 以上。

保留它的理由是零成本、无副作用,且为超大文档留了余地。

**5. 批量高度测量**

原先每个块各自 `requestAnimationFrame` 一次测量。现在合并成一帧末尾统一处理:
先读完所有高度,再统一写回。

专项对照:rect 调用次数从 76 降到 40(每 60 步),耗时 0.593ms → 0.145ms。

> 之所以保留:一是逻辑更清晰(读阶段与写阶段分离),二是未来若调整
> `estimateHeight` 让估算更准、测量路径被频繁触发时,批量化的价值才会显现。

### 实例复用(`recycle`)

> **默认开启。实测滚动开销从 1.44ms/步 降到 0.15ms/步(9.4x)。**

`recycle: true`(默认)会把滚出视口的 Editor 回收进池,滚回来时复用同一实例、
只替换文档内容(`Node.fromJSON`,不走 remark 解析)。

| overscan | recycle: false | recycle: true | 加速比 |
|---|---|---|---|
| 1 | 1.44 ms/步 | 0.15 ms/步 | **9.4x** |
| 2 | 1.45 ms/步 | 0.16 ms/步 | **9.0x** |
| 4 | 1.44 ms/步 | 0.19 ms/步 | **7.6x** |

**收益来自哪里?** 「创建 Editor」是挂载开销的绝大部分 —— 单次创建约 3.6ms,
而复用后换内容只需一次 `Node.fromJSON`(约 0.07ms)。省下的正是这 3.5ms。

注:与 dirty 标记的收益有重叠 —— 两者都作用于「卸载 + 重新挂载」这条路径。

**安全性已经验证:**

- 反复上下滚动 30 轮,每个挂载块的标题与内容**零错配**
- **跨块撤销不会污染** —— 换内容用 `addToHistory: false` 的事务,
  旧变换在新文档上无法应用会被 history 插件跳过。
  实测在 B 块连按 5 次 Ctrl+Z,内容始终是 B 块的;新块自己的撤销也完全正常。

**代价是内存** —— 池里常驻 `poolSize`(默认 `overscan + 1`)个 Editor 实例。
如果内存敏感,可以 `recycle: false` 关掉,代价是滚动时重新创建 Editor。

> **测量提醒**:评估这类优化时,不要在测试里 `await requestAnimationFrame()` ——
> rAF 按 60fps 节流,等帧测出的是帧间隔(16.7ms)而非实际开销,会得出完全错误的结论。
> 正确做法是 `scrollTop = x; await editor.sync()`,不主动等帧。

### 关闭缓存

```ts
new ChunkedEditor({
  scroller,
  content: markdown,
  disableCache: true,   // 不缓存 doc JSON,每次都走 markdown 解析
})
```

### 监控

```ts
editor.cacheStats
// { entries: 42, bytes: 128374, maxBytes: 33554432 }
```

## API

### `new ChunkedEditor(options)`

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `scroller` | `HTMLElement` | 必填 | 滚动容器 |
| `content` | `string` | 必填 | 初始 markdown |
| `splitLevel` | `number` | `2` | 切分粒度,标题级别 ≤ 该值的才切 |
| `overscan` | `number` | `1` | 视口外多挂载几屏,越大越顺滑、开销越大 |
| `onSave` | `(md: string) => void` | - | 内容变化回调(内部已防抖) |
| `onOutline` | `(items: OutlineItem[]) => void` | - | 大纲变化回调 |
| `cacheBytes` | `number` | `33554432` | doc 缓存上限(字节),32MB |
| `disableCache` | `boolean` | `false` | 关闭 doc 缓存,每次挂载都走 markdown 解析 |
| `recycle` | `boolean` | `true` | 启用实例复用。实测滚动开销降低 3.3x。关闭可省下池占用的内存 |
| `poolSize` | `number` | `overscan + 1` | 实例池容量(仅 recycle 开启时有效) |

**实例方法**

| 方法 | 说明 |
|---|---|
| `mount(): Promise<void>` | 开始挂载 |
| `destroy(): void` | 销毁全部实例并清理 DOM |
| `getMarkdown(): string` | 导出全文(会先 flush) |
| `getOutline(): OutlineItem[]` | 取大纲 |
| `scrollToChunk(id, align?)` | 滚动到指定块,`align` 为 `'start' \| 'center'` |

### 工具函数(可单独引入)

```ts
import { splitIntoChunks, joinChunks, buildOutline, estimateHeight } from 'milkdown-chunk-editor'
import { VirtualLayout } from 'milkdown-chunk-editor'

const { chunks, byId } = splitIntoChunks(md, 2)
```

`splitIntoChunks` / `joinChunks` / `VirtualLayout` 都是纯函数,不依赖 DOM,可用于 SSR 或自定义渲染层。

## 性能要点

- **不要用 `markdownUpdated`** — 它每次按键都全量 stringify 整块文档,是大文档最主要的卡顿源。
- **变更检测用自挂的 ProseMirror 插件** — 监听 `tr.docChanged`,而不是 `@milkdown/plugin-listener`
  的 `updated` 回调。后者内部有 200ms debounce,会让「内容是否被改过」这个信号本身延迟,
  卸载瞬间可能丢内容。
- **实例销毁前必须 flush** — 滚出视口的实例会立即销毁,内容已在 `destroy()` 内自动序列化回 store。
- **`content-visibility` 用 `auto` 而非 `hidden`** — `hidden` 会破坏 Ctrl+F 与无障碍树。
- **高度回填只处理「变矮」** — 变高会推走下方内容造成阅读跳动,这类误差保留为占位高度。

## 已知限制

- 跨块选区、跨块撤销、跨块拖拽**尚未实现**,需要自行在 `onSave` 之外补状态同步
- 与协同编辑(Y.js)存在冲突:协同需要单文档连续 CRDT,分片会破坏事务连续性。如需协同,建议只在块粒度上做合并
- 高度为估算值,极端排版(大量图片/表格)下滚动条可能有轻微位移

## 开发

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # tsx --test,27 项
npm run test:bench       # 性能基准对比(滚动场景)
npm run test:layout      # 高度表数据结构基准(Fenwick vs 数组前缀和)
npm run test:browser     # 真实 Chromium 验证
npm run test:layout-compare  # 布局优化前后对照(需 git HEAD 作为基线)
npm run build            # tsup → dist/
```

测试使用 [tsx](https://github.com/privatenumber/tsx) 运行 TypeScript,无需额外编译步骤。
端到端测试基于 happy-dom,会真实渲染 ProseMirror DOM。

CI 在 Node 20 / 22 上跑类型检查、测试、构建。

## License

MIT