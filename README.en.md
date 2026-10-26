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

### The three key optimizations

**1. Dirty flag — eliminates needless stringify**

Unconditionally calling `remark stringify` on unmount is the biggest waste: the user merely scrolled, the content never changed. Now the dirty flag is set only when `tr.docChanged` fires, and unmodified chunks skip serialization entirely.

> Implementation note: this deliberately does **not** use `@milkdown/plugin-listener`'s `updated` callback. That callback is internally debounced by 200 ms and detects changes via `prevDoc.eq(doc)`, which delays the very "has this been edited?" signal we need. At unmount time a stale flag means lost content. This package attaches its own ProseMirror plugin listening for `tr.docChanged` — immediate and semantically exact.

**2. doc JSON cache — eliminates repeated parsing**

If a chunk's markdown is identical to what it was last time, there is no reason to parse it again. An FNV-1a content fingerprint detects changes; on a hit the cached `{ type: 'json' }` is injected directly, so Milkdown takes the `Node.fromJSON` path — 5.4 ms down to 0.006 ms on a 3000-character chunk.

The cache evicts via LRU, with a 32 MB default ceiling (tune with `cacheBytes`).

**3. Sync deduplication + parallel mounting**

Both scroll events and `ResizeObserver` can trigger a sync. Without protection the same chunk gets mounted twice — doubling memory and letting one instance overwrite the other's content. There is now re-entrancy protection plus in-flight deduplication, and all pending chunks mount in parallel.

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

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # tsx --test, 20 assertions
npm run test:bench   # before/after performance comparison
npm run build        # tsup → dist/
```

Tests run TypeScript directly via [tsx](https://github.com/privatenumber/tsx) with no extra build step. End-to-end tests are based on happy-dom and genuinely render ProseMirror DOM.

CI runs type checking, tests and builds on Node 20 and 22.

## License

MIT
