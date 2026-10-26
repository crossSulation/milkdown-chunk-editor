/**
 * recycle(实例复用)路径的测试。
 *
 * 重点验证几个容易出错的地方:
 *   1. 复用后内容必须正确(tr.replace 需要 Slice,传裸 Fragment 会清空内容)
 *   2. 替换内容不应把 dirty 误置为 true(否则白跑一次 stringify)
 *   3. 选区必须重置到 inline 位置(设在 doc 顶层会抛错)
 *   4. 内容变更的回写必须落到正确的 chunk 上
 */
import { Window } from 'happy-dom'
import assert from 'node:assert/strict'

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
;(g as Record<string, unknown>).flushRaf = () => {
  const cbs = [...rafCallbacks.values()]
  rafCallbacks.clear()
  cbs.forEach((cb) => cb())
}

/** happy-dom 的 Element 类型与 DOM lib 不兼容,统一转换 */
type DomEl = HTMLElement

const { mountChunk } = await import('../src/mount-chunk.ts')
const { splitIntoChunks } = await import('../src/split.ts')
const { DocCache } = await import('../src/doc-cache.ts')
const { editorViewCtx } = await import('@milkdown/kit/core')
const { TextSelection } = await import('@milkdown/prose/state')

let pass = 0, fail = 0
function check(cond: unknown, msg: string) {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg) }
}

const CONTENT = [
  '# 标题一',
  '',
  '第一块的内容。',
  '',
  '## 小节 A',
  '',
  '更多内容。',
  '',
  '# 标题二',
  '',
  '第二块的内容。',
].join('\n')

const { chunks } = splitIntoChunks(CONTENT, 2)
assert.ok(chunks.length >= 2, '样本应切出至少 2 块')

console.log('\n== 1. 复用的基础行为 ==')
{
  const cache = new DocCache()
  const changes: Array<[string, string]> = []

  // 第一次挂载
  const slot1 = win.document.createElement('div') as unknown as DomEl
  const inst1 = await mountChunk({
    chunk: chunks[0],
    container: slot1,
    onChange: (id, md) => changes.push([id, md]),
  })
  const doc1 = inst1.editor.action((c) => c.get(editorViewCtx).state.doc)
  const json1 = doc1.toJSON()
  cache.set(chunks[0].id, chunks[0].markdown, json1)
  const text1 = doc1.textContent
  console.log(`  初始内容: "${text1}"`)
  check(text1.includes('第一块'), '初始内容正确')

  // detach 后复用
  inst1.detach()
  check(inst1.root.parentElement === null, 'detach 后 root 从 DOM 摘除')

  const slot2 = win.document.createElement('div') as unknown as DomEl
  inst1.attach(slot2)
  check(inst1.root.parentElement === slot2, 'attach 后 root 挂到新容器')

  // 换成第二块的内容
  const s2 = win.document.createElement('div') as unknown as DomEl
  const inst2 = await mountChunk({
    chunk: chunks[1],
    container: s2,
    onChange: (id, md) => changes.push([id, md]),
  })
  const doc2 = inst2.editor.action((c) => c.get(editorViewCtx).state.doc)
  const json2 = doc2.toJSON()
  const text2 = doc2.textContent

  inst1.replaceContent(json2)
  const docAfter = inst1.editor.action((c) => c.get(editorViewCtx).state.doc)
  console.log(`  替换后内容: "${docAfter.textContent}"`)
  check(docAfter.textContent === text2, '替换后内容与目标块完全一致')
  check(!docAfter.textContent.includes('第一块'), '旧内容已完全替换')
  check(docAfter.textContent.length > 0, '内容未被清空(Slice 用法正确)')

  await inst1.destroy()
  await inst2.destroy()
}

console.log('\n== 2. 替换内容不应误置 dirty ==')
{
  const cache = new DocCache()
  const changes: string[] = []
  const slot = win.document.createElement('div') as unknown as DomEl
  const inst = await mountChunk({
    chunk: chunks[0],
    container: slot,
    onChange: (id) => changes.push(id),
  })
  const json = inst.editor.action((c) => c.get(editorViewCtx).state.doc).toJSON()
  cache.set(chunks[0].id, chunks[0].markdown, json)

  check(inst.dirty === false, '刚挂载 dirty 为 false')
  inst.replaceContent(json)
  check(inst.dirty === false, '替换内容后 dirty 仍为 false(未被误判为用户编辑)')

  // flush 不应触发 onChange
  inst.flush()
  check(changes.length === 0, '未编辑时 flush 不触发回写')

  await inst.destroy()
}

console.log('\n== 3. 选区重置 ==')
{
  const slot = win.document.createElement('div') as unknown as DomEl
  const inst = await mountChunk({
    chunk: chunks[0],
    container: slot,
    onChange: () => {},
  })
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  // 先把选区放到文档末尾,模拟「用户在这个块里编辑过」
  const endPos = view.state.doc.content.size - 1
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endPos)))
  console.log(`  替换前选区: ${view.state.selection.from}`)

  const json = inst.editor.action((c) => c.get(editorViewCtx).state.doc).toJSON()
  let threw = false
  try {
    inst.replaceContent(json)
  } catch (err) {
    threw = true
    console.log('  ! 抛错:', String(err).slice(0, 80))
  }
  check(!threw, 'replaceContent 不抛错(选区重置到合法位置)')

  const after = inst.editor.action((c) => c.get(editorViewCtx).state)
  check(after.selection.from < after.doc.content.size, '选区在文档范围内')
  check(after.selection.from >= 0, '选区非负')
  console.log(`  选区位置: ${after.selection.from} / doc.size=${after.doc.content.size}`)

  await inst.destroy()
}

console.log('\n== 4. 回写到正确的 chunk ==')
{
  const changes: Array<[string, string]> = []
  const slot = win.document.createElement('div') as unknown as DomEl
  const inst = await mountChunk({
    chunk: chunks[0],
    container: slot,
    onChange: (id, md) => changes.push([id, md]),
  })

  // 模拟复用:改绑到 chunk-1
  inst.setChunkId('chunk-1')
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  view.dispatch(view.state.tr.insertText('X', 1))

  await new Promise((r) => setTimeout(r, 500))
  check(changes.length === 1, `编辑后回写一次 (实际 ${changes.length})`)
  check(changes[0]?.[0] === 'chunk-1', `回写到新绑定的 chunk (实际 ${changes[0]?.[0]})`)

  await inst.destroy()
}

console.log('\n== 5. 替换失败必须返回 false(否则会拿到旧内容)==')
{
  const slot = win.document.createElement('div') as unknown as DomEl
  const inst = await mountChunk({ chunk: chunks[0], container: slot, onChange: () => {} })

  // 用一个 schema 不兼容的 JSON —— fromJSON 会抛错
  const badJson = { type: 'doc', content: [{ type: 'notARealNodeType' }] }
  const result = inst.replaceContent(badJson)
  check(result === false, '替换失败时返回 false')
  console.log('  → 编排层据此销毁实例并重建,避免把上一个块的内容当新内容用')

  // 正常 JSON 应返回 true
  const goodJson = inst.editor.action((c) => c.get(editorViewCtx).state.doc).toJSON()
  check(inst.replaceContent(goodJson) === true, '替换成功时返回 true')

  await inst.destroy()
}

console.log('\n== 6. 编辑器池 ==')
{
  const { EditorPool } = await import('../src/editor-pool.ts')
  const pool = new EditorPool({ maxSize: 2 })
  check(pool.size === 0, '初始池为空')

  const slot = win.document.createElement('div') as unknown as DomEl
  const inst = await mountChunk({ chunk: chunks[0], container: slot, onChange: () => {} })
  pool.give(inst)
  check(pool.size === 1, '归还后池大小为 1')

  const taken = pool.take()
  check(taken === inst, 'take 返回刚归还的实例')
  check(pool.size === 0, 'take 后池为空')

  // 超出容量时销毁最早的
  const s2 = win.document.createElement('div') as unknown as DomEl
  const i2 = await mountChunk({ chunk: chunks[1], container: s2, onChange: () => {} })
  const s3 = win.document.createElement('div') as unknown as DomEl
  const i3 = await mountChunk({ chunk: chunks[1], container: s3, onChange: () => {} })
  pool.give(taken!)
  pool.give(i2)
  const destroyed = pool.give(i3)
  check(destroyed === 1, '超出容量时销毁 1 个实例')
  check(pool.size === 2, '池大小不超过上限')

  pool.clear()
  check(pool.size === 0, 'clear 后池为空')
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail > 0 ? 1 : 0)
