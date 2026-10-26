/**
 * 优化效果实测:对比「无缓存无 dirty 标记」与「优化后」在滚动场景下的耗时。
 *
 * 做法:构造 N 块文档,反复挂载/卸载同一批块(模拟滚动),
 * 分别用旧的朴素实现和新的优化实现,对比总耗时。
 */
import { Window } from 'happy-dom'

const win = new Window({ url: 'http://localhost' })
const g = globalThis as Record<string, unknown>
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement',
  'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'DOMParser', 'XMLSerializer', 'Range', 'Selection', 'Text',
  'NodeFilter', 'DocumentFragment', 'KeyboardEvent', 'MouseEvent',
  'InputEvent', 'ClipboardEvent', 'DragEvent', 'FocusEvent', 'CompositionEvent',
  'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver',
  'HTMLSlotElement', 'SVGElement', 'Image', 'CSS',
]) {
  const value = (win as unknown as Record<string, unknown>)[key]
  if (value === undefined) continue
  Object.defineProperty(g, key, { value, writable: true, configurable: true })
}
g.window = win
g.document = win.document
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  const fn = (win as unknown as Record<string, unknown>)[key]
  if (typeof fn === 'function') {
    Object.defineProperty(g, key, {
      value: (fn as (...args: unknown[]) => unknown).bind(win),
      writable: true, configurable: true,
    })
  }
}
let rafId = 0
const rafCallbacks = new Map<number, () => void>()
g.requestAnimationFrame = (cb: FrameRequestCallback) => {
  const id = ++rafId
  rafCallbacks.set(id, () => cb(Date.now()))
  return id
}
g.cancelAnimationFrame = (id: number) => { rafCallbacks.delete(id) }

const { mountChunk } = await import('../src/mount-chunk.ts')
const { splitIntoChunks } = await import('../src/split.ts')
const { DocCache } = await import('../src/doc-cache.ts')
const { editorViewCtx, serializerCtx } = await import('@milkdown/kit/core')

const content = `## 第 0 节\n\n${'正文内容。\n\n'.repeat(40)}`
const { chunks } = splitIntoChunks(content, 2)
const chunk = chunks[0]

async function mountOnce(cachedJson?: unknown) {
  const slot = win.document.createElement('div')
  const inst = await mountChunk({
    chunk,
    container: slot as unknown as HTMLElement,
    onChange: () => {},
    cachedJson,
  })
  return inst
}

/** 旧实现:无条件 markdown 解析 + 无条件序列化 */
async function naiveMount() {
  const inst = await mountOnce()
  // 无条件 stringify(旧行为)
  inst.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
  await inst.destroy()
  return inst
}

/** 新实现:缓存命中 → JSON 路径;dirty 为 false → 跳过 stringify */
async function optimizedMount(cache: InstanceType<typeof DocCache>) {
  const cached = cache.get(chunk.id, chunk.markdown)
  const inst = await mountOnce(cached?.json)
  // 回填缓存
  const doc = inst.editor.action((ctx) => ctx.get(editorViewCtx).state.doc)
  cache.set(chunk.id, chunk.markdown, doc.toJSON())
  // dirty 为 false → flush() 直接返回,不 stringify
  inst.flush()
  await inst.destroy()
  return inst
}

const ROUNDS = 12

console.log('=== 滚动场景实测(挂载+卸载同一块,重复 12 轮)===\n')

// 预热
await naiveMount()
await optimizedMount(new DocCache())

const t0 = process.hrtime.bigint()
for (let i = 0; i < ROUNDS; i++) await naiveMount()
const t1 = process.hrtime.bigint()
const naiveMs = Number(t1 - t0) / 1e6 / ROUNDS

const cache = new DocCache()
await optimizedMount(cache)
const t2 = process.hrtime.bigint()
for (let i = 0; i < ROUNDS; i++) await optimizedMount(cache)
const t3 = process.hrtime.bigint()
const optMs = Number(t3 - t2) / 1e6 / ROUNDS

console.log(`旧实现(无条件 parse + 无条件 stringify): ${naiveMs.toFixed(2)} ms/轮`)
console.log(`新实现(JSON 缓存 + dirty 标记):           ${optMs.toFixed(2)} ms/轮`)
console.log(`\n提速: ${(naiveMs / optMs).toFixed(1)}x`)
console.log(`单轮节省: ${(naiveMs - optMs).toFixed(2)} ms`)

console.log('\n=== 换算到真实滚动场景 ===')
const blocksPerScreen = 3
console.log(`每屏 ${blocksPerScreen} 块,滚动一次:`)
console.log(`  旧: ${(naiveMs * blocksPerScreen).toFixed(1)} ms`)
console.log(`  新: ${(optMs * blocksPerScreen).toFixed(1)} ms`)
console.log(`  帧预算 16.7ms → 旧 ${naiveMs * blocksPerScreen > 16.7 ? '❌ 掉帧' : '✅'}, 新 ${optMs * blocksPerScreen > 16.7 ? '❌ 掉帧' : '✅ 无感'}`)

console.log('\n=== 缓存命中率 ===')
const c2 = new DocCache()
const hit1 = c2.get(chunk.id, chunk.markdown)
console.log(`首次查询(未写入)命中: ${hit1 !== undefined}`)
c2.set(chunk.id, chunk.markdown, { type: 'doc', content: [] })
const hit2 = c2.get(chunk.id, chunk.markdown)
console.log(`写入后查询命中: ${hit2 !== undefined}`)
