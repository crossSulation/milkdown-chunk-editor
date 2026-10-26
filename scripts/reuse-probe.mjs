/**
 * 复用原型:用于实测收益与验证边界问题。不进正式包。
 *
 * 复用语义:
 *   - 卸载时把实例"回收"到池中,不销毁 EditorState/EditorView/插件图
 *   - 挂载时从池中取出,用 Node.fromJSON 换内容(不走 remark)
 *   - 换内容后重置选区到文档开头
 *   - 换内容触发的 docChanged 要抑制,否则 dirty 误判
 */
import { Window } from 'happy-dom'

const win = new Window({ url: 'http://localhost' })
const g = globalThis
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
  const v = win[key]
  if (v === undefined) continue
  Object.defineProperty(g, key, { value: v, writable: true, configurable: true })
}
g.window = win
g.document = win.document
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  const fn = win[key]
  if (typeof fn === 'function') {
    Object.defineProperty(g, key, { value: fn.bind(win), writable: true, configurable: true })
  }
}
let rafId = 0
const rafCallbacks = new Map()
g.requestAnimationFrame = (cb) => { const id = ++rafId; rafCallbacks.set(id, () => cb(Date.now())); return id }
g.cancelAnimationFrame = (id) => rafCallbacks.delete(id)

const { mountChunk } = await import('../src/mount-chunk.ts')
const { splitIntoChunks } = await import('../src/split.ts')
const { DocCache } = await import('../src/doc-cache.ts')
const { editorViewCtx, schemaCtx } = await import('@milkdown/kit/core')
const { Node: PMNode } = await import('@milkdown/prose/model')
const { TextSelection } = await import('@milkdown/prose/state')

// ---- 构造文档 ----
function makeDoc(chunkCount, charsPerChunk) {
  const parts = []
  for (let i = 0; i < chunkCount; i++) {
    parts.push(`## Section ${i}\n\n` + '正文内容。'.repeat(Math.floor(charsPerChunk / 5)))
  }
  return parts.join('\n\n')
}

// ---- 方案 A:当前实现(销毁重建) ----
async function scenarioRebuild(chunks, cache, rounds) {
  const t0 = process.hrtime.bigint()
  for (let r = 0; r < rounds; r++) {
    for (const chunk of chunks) {
      const slot = win.document.createElement('div')
      const inst = await mountChunk({
        chunk,
        container: slot,
        onChange: () => {},
        cachedJson: cache.get(chunk.id, chunk.markdown)?.json,
      })
      await inst.destroy()
    }
  }
  const t1 = process.hrtime.bigint()
  return Number(t1 - t0) / 1e6 / rounds
}

// ---- 方案 B:复用(池化 + fromJSON 换内容) ----
async function scenarioReuse(chunks, cache, rounds, poolSize) {
  const pool = []
  const t0 = process.hrtime.bigint()

  for (let r = 0; r < rounds; r++) {
    for (const chunk of chunks) {
      let inst
      if (pool.length > 0) {
        inst = pool.pop()
        // 换内容:直接用 fromJSON,绕过 remark
        const view = inst.editor.action((c) => c.get(editorViewCtx))
        const schema = inst.editor.action((c) => c.get(schemaCtx))
        const json = cache.get(chunk.id, chunk.markdown)?.json
        if (json) {
          const newDoc = PMNode.fromJSON(schema, json)
          view.dispatch(view.state.tr.replace(0, view.state.doc.content.size, newDoc.content))
          // 重置选区到开头,否则会残留上一个块的光标位置
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 0)))
        }
        // 换 DOM 宿主
        const slot = win.document.createElement('div')
        slot.appendChild(inst.root)
      } else {
        const slot = win.document.createElement('div')
        inst = await mountChunk({
          chunk,
          container: slot,
          onChange: () => {},
          cachedJson: cache.get(chunk.id, chunk.markdown)?.json,
        })
      }
      // 回收:不销毁,只摘 DOM
      inst.root.remove()
      if (pool.length < poolSize) pool.push(inst)
      else await inst.destroy()
    }
  }
  const t1 = process.hrtime.bigint()
  for (const inst of pool) await inst.destroy()
  return Number(t1 - t0) / 1e6 / rounds
}

// ---- 预热 + 建缓存 ----
const CHUNKS = 3
const CHARS = 3000
const content = makeDoc(CHUNKS, CHARS)
const { chunks } = splitIntoChunks(content, 2)
const cache = new DocCache()

{
  for (const chunk of chunks) {
    const slot = win.document.createElement('div')
    const inst = await mountChunk({ chunk, container: slot, onChange: () => {} })
    const doc = inst.editor.action((c) => c.get(editorViewCtx).state.doc)
    cache.set(chunk.id, chunk.markdown, doc.toJSON())
    await inst.destroy()
  }
}

// ---- 预热 JIT ----
await scenarioRebuild(chunks, cache, 2)
await scenarioReuse(chunks, cache, 2, 3)

const ROUNDS = 30
console.log(`=== 场景:${CHUNKS} 块 × ${CHARS} 字符,滚动 ${ROUNDS} 轮 ===\n`)

const rebuild = await scenarioRebuild(chunks, cache, ROUNDS)
const reuse = await scenarioReuse(chunks, cache, ROUNDS, 3)

console.log(`A. 销毁重建(当前):  ${rebuild.toFixed(3)} ms/轮`)
console.log(`B. 池化复用:          ${reuse.toFixed(3)} ms/轮`)
console.log(`\n节省: ${(rebuild - reuse).toFixed(3)} ms/轮  (${(rebuild / reuse).toFixed(1)}x)`)

// 换算到滚动场景
console.log('\n=== 换算到真实滚动 ===')
for (const [label, perScreen] of [['每屏 3 块', 3], ['每屏 6 块', 6]]) {
  const a = rebuild / CHUNKS * perScreen
  const b = reuse / CHUNKS * perScreen
  console.log(`${label}: 重建 ${a.toFixed(1)}ms → 复用 ${b.toFixed(1)}ms  (省 ${(a - b).toFixed(1)}ms)`)
}

// 内存对比
console.log('\n=== 内存驻留 ===')
console.log(`销毁重建: 0 个常驻实例(峰值 3 个)`)
console.log(`池化复用: 3 个常驻实例 + 缓存 JSON`)
