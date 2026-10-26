# milkdown-chunk-editor

[English](./README.en.md) | [简体中文](./README.md)

A rich-text editor for large documents, built on [Milkdown](https://milkdown.dev/) and ProseMirror: **splits the document by heading and virtualizes the viewport**, mounting editor instances only for the visible region.

## Why this exists

ProseMirror creates a DOM element for **every node** in the document and keeps them in sync. The larger the document, the more DOM validation and repainting each keystroke triggers — input latency grows linearly with node count.

ProseMirror's author, marijn, [stated on the official forum](https://discuss.prosemirror.net/t/different-parsing-strategy-for-large-documents/1017) that virtualization for large documents is out of scope and not planned for the core library. His recommendation was to "give each chapter its own ProseMirror instance."

This package implements exactly that idea:

1. **Document layer** — splits markdown into chunks by H1/H2, with a code-fence state machine (a `#` inside a fence is not a heading)
2. **Viewport layer** — maintains its own prefix-sum height table and binary-searches the visible range, mounting standalone editor instances only within the overscan window
3. **Render layer** — `content-visibility: auto` lets mounted-but-offscreen DOM skip layout and paint

> **Heads up:** APIs like `@milkdown/plugin-virtual-scroll` or `crepe.configure({ virtualization })` **do not exist**. Plenty of tutorials online show them, but that code is fictional. Don't copy it.

## Browser compatibility

The package depends on **no Node built-in modules** — the output is pure ESM and runs directly in browsers, WebViews and Tauri.

About `Node.fromJSON` — the `Node` here is **ProseMirror's `Node` class** (`prosemirror-model`), not Node.js. It is a pure JS implementation that touches neither `process`, `Buffer` nor `require`, so it works fine in the browser.

Verified against real Chromium (esbuild bundle + Playwright):

```
No process / require / Buffer        ✓
Node.fromJSON path available          ✓
ProseMirror renders for real          ✓
content-visibility applied            ✓
Virtual scrolling works (5 of 40 mounted)  ✓
Zero Node built-in module references  ✓
```

Run `npm run test:browser` to reproduce.

### WebView notes

- `content-visibility: auto` requires **Chrome 85+ / Safari 18+**. Older WebViews ignore it — you only lose the paint optimization, functionality is unaffected.
- The first mount has to parse markdown. For large documents, keep `disableCache: false` (the default) so the cache can be reused.

## Installation

```bash
npm i milkdown-chunk-editor
# peer dependency
npm i @milkdown/kit
```

### ESM only

`@milkdown/kit` declares only an `import` condition in its `exports` map — there is no `require` — so this package ships **no CJS build** either. In a CommonJS environment, use a dynamic `import()`:

```js
const { ChunkedEditor } = await import('milkdown-chunk-editor')
```

Bundlers (Vite / webpack / Rollup) are unaffected.

## Usage

```ts
import { ChunkedEditor } from 'milkdown-chunk-editor'
import 'milkdown-chunk-editor/style.css'

const editor = new ChunkedEditor({
  scroller: document.getElementById('scroller')!,
  content: markdown,
  splitLevel: 2,      // 1 = split on H1 (chapters), 2 = split on H1/H2 (sections, default)
  overscan: 1,        // extra screens to mount beyond the viewport
  onSave: (md) => persist(md),
  onOutline: (items) => renderSidebar(items),
})

await editor.mount()

// Jump from the outline
editor.scrollToChunk('chunk-12', 'center')

// Export the full document (flushes all mounted instances first)
const full = editor.getMarkdown()

// Tear down
editor.destroy()
```

### HTML structure

The scroll container needs a definite height. The package sets `position: relative` for you:

```html
<div id="scroller" style="height: 100vh; overflow-y: auto"></div>
```

## Performance

### Measured numbers

Per 3000-character chunk (measured in Node on hardware comparable to a Chrome-class machine):

| Operation | Cost |
|---|---|
| remark parse (cold path) | 5.4 ms |
| remark stringify | 8.7 ms |
| `Node.fromJSON` (cache hit) | 0.006 ms |
| Content fingerprint | ~0.002 ms |

Scrolling scenario (mount + unmount 3 chunks):

| | Per cycle | One scroll (3 chunks) | 16.7 ms frame budget |
|---|---|---|---|
| Before optimization | 8.86 ms | 26.6 ms | ❌ drops frames |
| After optimization | 2.16 ms | 6.5 ms | ✅ imperceptible |

**Measured 4.1x speedup.**

### The five key optimizations

**1. Dirty flag — eliminates needless stringify**

Unconditionally calling `remark stringify` on unmount is the biggest waste: the user merely scrolled, the content never changed. Now the dirty flag is set only when `tr.docChanged` fires, and unmodified chunks skip serialization entirely.

> Implementation note: this deliberately does **not** use `@milkdown/plugin-listener`'s `updated` callback. That callback is internally debounced by 200 ms and detects changes via `prevDoc.eq(doc)`, which delays the very "has this been edited?" signal we need. At unmount time a stale flag means lost content. This package attaches its own ProseMirror plugin listening for `tr.docChanged` — immediate and semantically exact.

**2. doc JSON cache — eliminates repeated parsing**

If a chunk's markdown is identical to what it was last time, there is no reason to parse it again. An FNV-1a content fingerprint detects changes; on a hit the cached `{ type: 'json' }` is injected directly, so Milkdown takes the `Node.fromJSON` path — 5.4 ms down to 0.006 ms on a 3000-character chunk.

The cache evicts via LRU, with a 32 MB default ceiling (tune with `cacheBytes`).

**3. Sync deduplication + parallel mounting**

Both scroll events and `ResizeObserver` can trigger a sync. Without protection the same chunk gets mounted twice — doubling memory and letting one instance overwrite the other's content. There is now re-entrancy protection plus in-flight deduplication, and all pending chunks mount in parallel.

**4. Height table: Fenwick Tree**

The height table used to be "array prefix sums + binary search", so updating one chunk's height meant an O(n) full rebuild. As a tree array, a single update drops to O(log n):

| Chunks | Before (per update) | After | Speedup |
|---|---|---|---|
| 100 | 0.22 μs | 0.19 μs | 1.2x |
| 1 000 | 6.04 μs | 0.23 μs | 26x |
| 10 000 | 44.7 μs | 0.14 μs | 319x |
| 100 000 | 933 μs | 0.31 μs | 2985x |

**But to be clear: everyday document sizes won't benefit.** Measured at 80 chunks, layout computation accounts for 0.01% of scroll time — completely drowned out by browser rendering. You'd need roughly 35 000 chunks before Fenwick's advantage reaches 5% of scroll time.

It stays because it costs nothing, has no side effects, and leaves headroom for very large documents.

**5. Batched height measurement**

Each chunk used to schedule its own `requestAnimationFrame` measurement. Now they are merged into a single pass at the end of a frame: read all heights first, then write everything back.

**Measured benefit: zero.** Browsers defer style writes to the end of the frame, so alternating reads and writes within one frame does not trigger multiple layouts. All three modes (read-only / alternating read-write / batched read-write) produced an identical `LayoutCount`.

It is kept anyway for two reasons: the logic is clearer (read phase and write phase are separated), and if `estimateHeight` is ever tuned to be more accurate — making the measurement path fire frequently — batching would then start to pay off.

> Incidentally: the height estimate turns out to be quite accurate (1664 px actual vs 1644 px estimated for English text, a 1% error), so the measurement path rarely fires in practice. That is also the root reason why the optimizations above show no measurable gain in the browser: **the current bottleneck is browser rendering, not JS computation.**

### Instance recycling (`recycle`)

> **Measured result: off by default, and we recommend leaving it off.**

With `recycle: true`, Editors that scroll out of the viewport are returned to a pool
instead of being destroyed; scrolling back reuses the same instance and only swaps the
document content (`Node.fromJSON`, no remark parsing). That sounds appealing, but the
measured benefit falls far short of expectations:

| Scenario | recycle: false | recycle: true | Difference |
|---|---|---|---|
| Chromium scrolling (60-chunk document) | 16.65 ms/step | 16.66 ms/step | **1.00x** |
| Node, all cache hits | — | — | 1.06x |

**Why no benefit?** Two reasons:

1. **Creating an Editor is already cheap once the cache hits.** With a cached doc JSON,
   `mountChunk` takes the `Node.fromJSON` path (0.006 ms) and skips the expensive remark
   parsing entirely.
2. **Creating the Editor is not where scrolling time goes.** `sync()` itself measures
   about 2.7 ms; the rest is browser layout and paint. Everything recycling can save
   already lives inside that 2.7 ms.

It also carries real semantic costs:

- **Cross-chunk undo becomes unreliable** — a recycled instance still holds the previous
  chunk's undo history, so Ctrl+Z in a new chunk can restore the old chunk's content.
- **Content mix-up risk** — forcing reuse when the cache misses leaves the instance
  holding the previous chunk's content. This implementation avoids it (the instance is
  discarded and rebuilt instead), but it shows how fragile the reuse path is.

If you still hit scroll jank on very large documents, more productive directions are:
raise `splitLevel` for smaller chunks, lower `overscan`, or check whether scrolling
triggers unnecessary re-layout.

### Disabling the cache

```ts
new ChunkedEditor({
  scroller,
  content: markdown,
  disableCache: true,   // never cache doc JSON; always parse from markdown
})
```

### Monitoring

```ts
editor.cacheStats
// { entries: 42, bytes: 128374, maxBytes: 33554432 }
```

## API

### `new ChunkedEditor(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `scroller` | `HTMLElement` | required | Scroll container |
| `content` | `string` | required | Initial markdown |
| `splitLevel` | `number` | `2` | Split granularity — only headings at or above this level cause a split |
| `overscan` | `number` | `1` | Extra screens mounted beyond the viewport; higher is smoother but costlier |
| `onSave` | `(md: string) => void` | - | Called when content changes (already debounced internally) |
| `onOutline` | `(items: OutlineItem[]) => void` | - | Called with the outline |
| `cacheBytes` | `number` | `33554432` | doc cache ceiling in bytes (32 MB) |
| `disableCache` | `boolean` | `false` | Disable the doc cache; every mount parses from markdown |
| `recycle` | `boolean` | `false` | Enable instance recycling. **Measured benefit is near zero and cross-chunk undo becomes unreliable** — not recommended |
| `poolSize` | `number` | `overscan + 1` | Instance pool capacity (only used when recycling is on) |

**Instance methods**

| Method | Description |
|---|---|
| `mount(): Promise<void>` | Start mounting |
| `destroy(): void` | Destroy all instances and clean up the DOM |
| `getMarkdown(): string` | Export the full document (flushes first) |
| `getOutline(): OutlineItem[]` | Get the outline |
| `scrollToChunk(id, align?)` | Scroll to a chunk; `align` is `'start' \| 'center'` |

### Standalone utilities

```ts
import { splitIntoChunks, joinChunks, buildOutline, estimateHeight } from 'milkdown-chunk-editor'
import { VirtualLayout } from 'milkdown-chunk-editor'

const { chunks, byId } = splitIntoChunks(md, 2)
```

`splitIntoChunks`, `joinChunks` and `VirtualLayout` are pure functions with no DOM dependency — usable for SSR or a custom render layer.

## Performance notes

- **Avoid `markdownUpdated`** — it fully stringifies the chunk on every keystroke, the single largest source of jank in large documents.
- **Change detection uses a self-attached ProseMirror plugin** listening for `tr.docChanged`, rather than `@milkdown/plugin-listener`'s `updated` callback. The latter's internal 200 ms debounce delays the "was this edited?" signal, which risks losing content at unmount time.
- **Instances must be flushed before destruction** — instances leaving the viewport are destroyed immediately; content is serialized back into the store inside `destroy()`.
- **Use `content-visibility: auto`, not `hidden`** — `hidden` breaks Ctrl+F and the accessibility tree.
- **Height backfill only handles "got shorter"** — growing taller would push the content below down and interrupt reading, so that error is left as a placeholder.

## Known limitations

- **Cross-chunk selection, cross-chunk undo, and cross-chunk drag-and-drop are not implemented.** You will need to add your own state synchronization outside `onSave`.
- **Conflicts with collaborative editing (Y.js).** Collaboration requires one continuous CRDT document, and chunking breaks transaction continuity. If you need collaboration, consider merging at chunk granularity only.
- **Heights are estimates.** With extreme layouts (many images or tables) the scrollbar may drift slightly.
- **With `recycle` enabled, cross-chunk undo is unreliable** — a recycled instance retains the previous chunk's undo history.

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # tsx --test, 27 assertions
npm run test:bench       # scrolling performance comparison
npm run test:layout      # height-table data structure benchmark (Fenwick vs array prefix sums)
npm run test:browser     # real Chromium verification
npm run test:layout-compare  # before/after layout comparison (baseline = git HEAD)
npm run build            # tsup → dist/
```

Tests run TypeScript directly via [tsx](https://github.com/privatenumber/tsx) with no extra build step. End-to-end tests are based on happy-dom and genuinely render ProseMirror DOM.

CI runs type checking, tests and builds on Node 20 and 22.

## License

MIT
