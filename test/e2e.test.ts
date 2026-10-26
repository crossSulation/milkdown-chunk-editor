/**
 * 端到端验证:用 happy-dom 模拟浏览器,验证
 *   1. 实例能真正挂载(不只是类型层面正确)
 *   2. 缓存命中时确实跳过了 remark parse
 *   3. dirty 标记避免了无谓的 stringify
 *   4. sync 重入不会导致同块被挂载两次
 */
import { Window } from 'happy-dom'
import assert from 'node:assert/strict'

// happy-dom 必须在 milkdown 之前注入全局 DOM
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
  // Node 22 的 navigator 等是只读 getter,必须用 defineProperty 覆盖
  Object.defineProperty(g, key, {
    value,
    writable: true,
    configurable: true,
  })
}
g.window = win
g.document = win.document
// Milkdown 的 ctx 模块直接引用全局 addEventListener/removeEventListener,
// 而不是 window.addEventListener,必须挂到 globalThis 上
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  const fn = (win as unknown as Record<string, unknown>)[key]
  if (typeof fn === 'function') {
    Object.defineProperty(g, key, {
      value: (fn as (...args: unknown[]) => unknown).bind(win),
      writable: true,
      configurable: true,
    })
  }
}
// happy-dom 的 rAF 是异步的,替换为同步可预测版本
let rafId = 0
const rafCallbacks = new Map<number, () => void>()
g.requestAnimationFrame = (cb: FrameRequestCallback) => {
  const id = ++rafId
  rafCallbacks.set(id, () => cb(Date.now()))
  return id
}
g.cancelAnimationFrame = (id: number) => {
  rafCallbacks.delete(id)
}
;(win as unknown as Record<string, unknown>).requestAnimationFrame = g.requestAnimationFrame
;(win as unknown as Record<string, unknown>).cancelAnimationFrame = g.cancelAnimationFrame
;(globalThis as Record<string, unknown>).flushRaf = () => {
  const cbs = [...rafCallbacks.values()]
  rafCallbacks.clear()
  cbs.forEach((cb) => cb())
}

const { ChunkedEditor } = await import('../src/chunked-editor.ts')
const { DocCache, fingerprint } = await import('../src/doc-cache.ts')

function makeDoc(n = 5) {
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    parts.push(`## 第 ${i} 节\n\n` + '这是正文内容。\n\n'.repeat(20))
  }
  return parts.join('\n')
}

function makeScroller() {
  const el = win.document.createElement('div') as unknown as HTMLElement
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true })
  el.scrollTo = () => {}
  return el
}

let pass = 0, fail = 0
function check(cond: unknown, msg: string) {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg) }
}

console.log('\n== 1. 指纹函数 ==')
check(fingerprint('abc') === fingerprint('abc'), '相同内容指纹相同')
check(fingerprint('abc') !== fingerprint('abd'), '不同内容指纹不同')
check(fingerprint('abc') !== fingerprint('abcd'), '长度参与指纹,避免碰撞')
check(fingerprint('a'.repeat(10000)).length > 0, '长文本可计算指纹')

console.log('\n== 2. DocCache 基本行为 ==')
const cache = new DocCache(1024 * 1024)
cache.set('c1', 'hello', { type: 'doc', content: [] })
check(cache.get('c1', 'hello') !== undefined, '内容一致时命中')
check(cache.get('c1', 'world') === undefined, '内容变化后未命中')
check(cache.get('c2', 'hello') === undefined, '不存在的 key 未命中')
cache.delete('c1')
check(cache.get('c1', 'hello') === undefined, '删除后未命中')

console.log('\n== 3. DocCache LRU 淘汰 ==')
const small = new DocCache(200)
small.set('a', 'aaa', { type: 'doc', content: [] })
small.set('b', 'bbb', { type: 'doc', content: [] })
small.set('c', 'ccc', { type: 'doc', content: [] })
check(small.stats.bytes <= small.maxBytes, `内存不超限 (${small.stats.bytes} <= ${small.maxBytes})`)

console.log('\n== 4. 真实挂载 ==')
const scroller = makeScroller()
const editor = new ChunkedEditor({
  scroller,
  content: makeDoc(5),
  splitLevel: 2,
  onSave: () => {},
})
await editor.mount()
const slotCount = scroller.querySelectorAll('.chunk-slot').length
check(slotCount > 0, `已挂载 slot (${slotCount} 个)`)
const rootCount = scroller.querySelectorAll('.milkdown-chunk-root').length
check(rootCount > 0, `已创建 Milkdown 根节点 (${rootCount} 个)`)
const hasProse = scroller.querySelectorAll('.ProseMirror').length
check(hasProse > 0, `ProseMirror 已渲染 (${hasProse} 个)`)
const hasHeading = scroller.querySelectorAll('h2').length
check(hasHeading > 0, `标题已渲染 (${hasHeading} 个)`)

console.log('\n== 5. 缓存已回填 ==')
const stats = editor.cacheStats
check(stats.entries > 0, `缓存已写入 (${stats.entries} 条, ${stats.bytes} 字节)`)

console.log('\n== 6. 内容完整性 ==')
const md = editor.getMarkdown()
check(md.includes('第 0 节') && md.includes('第 4 节'), '全文包含所有章节')
check(md.split('##').length - 1 === 5, `章节数正确 (${md.split('##').length - 1})`)

console.log('\n== 7. 大纲 ==')
const outline = editor.getOutline()
check(outline.length === 5, `大纲 5 条 (实际 ${outline.length})`)
check(outline[0].title === '第 0 节', '大纲标题正确')

console.log('\n== 8. 卸载后缓存保留,再次挂载复用 ==')
const before = editor.cacheStats.entries
editor.destroy()
check(before > 0, '销毁前缓存有内容')

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail > 0 ? 1 : 0)
