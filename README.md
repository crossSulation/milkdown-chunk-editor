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

在 3000 字符的单块上(Chrome 同级机器,Node 环境实测):

| 操作 | 耗时 |
|---|---|
| remark parse(冷路径) | 5.4 ms |
| remark stringify | 8.7 ms |
| `Node.fromJSON`(缓存命中) | 0.006 ms |
| 内容指纹计算 | ~0.002 ms |

滚动场景(挂载 + 卸载 3 块):

| | 每轮 | 滚动一次(3 块) | 帧预算 16.7ms |
|---|---|---|---|
| 未优化 | 8.86 ms | 26.6 ms | ❌ 掉帧 |
| 优化后 | 2.16 ms | 6.5 ms | ✅ 无感 |

**实测提速 4.1x。**

### 三项关键优化

**1. dirty 标记 —— 消除无谓的 stringify**

卸载块时无条件调 `remark stringify` 是最大的浪费:用户只是滚了一下,内容根本没变。
现在只有 `tr.docChanged` 触发时才置 dirty,未修改的块直接跳过序列化。

> 实现细节:没有使用 `@milkdown/plugin-listener` 的 `updated` 回调 —— 它内部有 200ms
> debounce,且用 `prevDoc.eq(doc)` 判断变化,导致「内容是否被改过」这个信号本身就延迟。
> 本包直接挂 ProseMirror 插件监听 `tr.docChanged`,立即触发且语义精确。

**2. doc JSON 缓存 —— 消除重复的 parse**

块的 markdown 内容和上次挂载时相同,就没必要重新解析。
用 FNV-1a 内容指纹判断是否变化,命中则直接注入 `{ type: 'json' }`,
Milkdown 走 `Node.fromJSON` 路径 —— 3000 字符块上从 5.4ms 降到 0.006ms。

缓存按 LRU 淘汰,默认上限 32MB(可用 `cacheBytes` 调整)。

**3. sync 去重 + 并行挂载**

滚动事件与 `ResizeObserver` 都会触发同步,若不加保护,同一块会被挂载两个实例
(内存翻倍且内容互相覆盖)。现在有重入保护 + in-flight 去重,并行挂载所有待加载块。

### 实例复用(`recycle`)

> **实测结论:默认关闭,且不建议你开启。**

`recycle: true` 会把滚出视口的 Editor 回收进池,滚回来时复用同一实例、只替换文档内容
(`Node.fromJSON`,不走 remark 解析)。听起来很美,但实测下来收益远低于预期:

| 场景 | recycle: false | recycle: true | 差异 |
|---|---|---|---|
| Chromium 滚动(60 块文档) | 16.65 ms/步 | 16.66 ms/步 | **1.00x** |
| Node 环境,缓存全命中 | — | — | 1.06x |

**为什么没有收益?** 有两个原因:

1. **缓存命中时创建成本本来就不高。** 有 doc JSON 缓存时,`mountChunk` 走
   `Node.fromJSON` 路径(0.006ms),已经跳过了昂贵的 remark 解析。
2. **滚动的大头不在创建 Editor。** 实测 `sync()` 本身只有约 2.7ms,
   其余是浏览器布局与绘制。recycle 能省的部分本来就在这 2.7ms 里面。

另外它引入了真实的语义代价:

- **跨块撤销不可靠** — 复用的实例仍持有上一个块的 undo 历史,
  在新块里按 Ctrl+Z 可能撤回到旧块的内容。
- **内容错乱风险** — 缓存未命中时若强行复用,实例会保留上一个块的内容。
  本实现已规避(此时丢弃实例重建),但这说明复用路径比看起来脆弱。

如果你在超大文档上仍遇到滚动卡顿,更有效的方向是:
调大 `splitLevel` 让块更小、减小 `overscan`、或排查是否在滚动中触发了
不必要的 re-layout。

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
| `recycle` | `boolean` | `false` | 启用实例复用。**实测收益接近 0,且跨块撤销不可靠**,不建议开启 |
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
- 开启 `recycle` 后跨块撤销不可靠(复用的实例保留上一个块的 undo 历史)

## 开发

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # tsx --test,20 项
npm run test:bench   # 性能基准对比
npm run build        # tsup → dist/
```

测试使用 [tsx](https://github.com/privatenumber/tsx) 运行 TypeScript,无需额外编译步骤。
端到端测试基于 happy-dom,会真实渲染 ProseMirror DOM。

CI 在 Node 20 / 22 上跑类型检查、测试、构建。

## License

MIT