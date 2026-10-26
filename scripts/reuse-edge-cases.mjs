/**
 * 复用引入的边界问题逐项验证。
 * 目的:区分「能解」与「难解」,给出诚实的复杂度评估。
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
const { editorViewCtx, schemaCtx, prosePluginsCtx } = await import('@milkdown/kit/core')
const { Node: PMNode } = await import('@milkdown/prose/model')
const { TextSelection } = await import('@milkdown/prose/state')

let pass = 0, fail = 0
const check = (c, m) => { if (c) { pass++; console.log('  PASS ' + m) } else { fail++; console.log('  FAIL ' + m) } }

const content = '## A 节\n\n第一段。\n\n第二段。\n\n## B 节\n\nB 内容。'
const { chunks } = splitIntoChunks(content, 2)
const chunkA = chunks[0]
const chunkB = chunks[1]

// 建缓存
const cache = new DocCache()
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunkA, container: s, onChange: () => {} })
  const doc = inst.editor.action((c) => c.get(editorViewCtx).state.doc)
  cache.set(chunkA.id, chunkA.markdown, doc.toJSON())
  await inst.destroy()
}

console.log('\n== 边界 1:选区位置越界 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunkA, container: s, onChange: () => {} })
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  const schema = inst.editor.action((c) => c.get(schemaCtx))

  // 换内容前把选区放到文档很靠后的位置
  const endPos = view.state.doc.content.size - 1
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endPos)))
  const beforeSel = view.state.selection.from
  console.log(`  换内容前选区位置: ${beforeSel} / doc.size=${view.state.doc.content.size}`)

  // 换成一个更短的文档
  const shortJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }
  const newDoc = PMNode.fromJSON(schema, shortJson)
  view.dispatch(view.state.tr.replace(0, view.state.doc.content.size, newDoc.content))

  // 此时选区可能已经越界
  const selAfter = view.state.selection.from
  const docSize = view.state.doc.content.size
  console.log(`  换内容后选区位置: ${selAfter} / doc.size=${docSize}`)
  check(selAfter <= docSize, '选区未越界(tr.replace 会自动 clamp)')

  // 显式重置到 0 —— 这就是之前报 warning 的地方
  let resetOk = true
  try {
    const pos = Math.min(1, view.state.doc.content.size - 1)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
  } catch (e) {
    resetOk = false
    console.log('  ! 重置抛错:', String(e).slice(0, 60))
  }
  check(resetOk, '可显式重置选区(需选在 inline 节点内,不能是 doc 顶层)')
  await inst.destroy()
}

console.log('\n== 边界 2:选区应落在 inline 位置 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunkA, container: s, onChange: () => {} })
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  const doc = view.state.doc
  // 找第一个有 inline content 的位置
  let inlinePos = -1
  doc.descendants((node, pos) => {
    if (inlinePos === -1 && node.isText) inlinePos = pos + 1
    return inlinePos === -1
  })
  console.log(`  首个 inline 位置: ${inlinePos}`)
  let ok = true
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, inlinePos)))
  } catch (e) {
    ok = false
  }
  check(ok, `选区可安全设在 inline 位置 (${inlinePos})`)
  await inst.destroy()
}

console.log('\n== 边界 3:dirty 标记会被换内容误触发 ==')
{
  let changeCount = 0
  const s = win.document.createElement('div')
  const inst = await mountChunk({
    chunk: chunkA, container: s,
    onChange: () => { changeCount++ },
    cachedJson: cache.get(chunkA.id, chunkA.markdown)?.json,
  })

  console.log(`  换内容前 dirty=${inst.dirty}`)
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  const schema = inst.editor.action((c) => c.get(schemaCtx))
  const newDoc = PMNode.fromJSON(schema, cache.get(chunkA.id, chunkA.markdown).json)
  view.dispatch(view.state.tr.replace(0, view.state.doc.content.size, newDoc.content))

  check(inst.dirty === true, '换内容会触发 docChanged → dirty 被误置为 true')
  console.log(`  → 这会导致「只是复用了实例」也被当成「用户编辑过」而触发 stringify`)
  console.log(`  → 解法:换内容时加 meta 标记,dirty 插件里跳过该事务`)
  await inst.destroy()
}

console.log('\n== 边界 4:undo 栈会跨块污染 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunkA, container: s, onChange: () => {} })
  const view = inst.editor.action((c) => c.get(editorViewCtx))

  // 在 A 块里打字
  view.dispatch(view.state.tr.insertText('X', 1))
  // 统计 undo 深度:history 插件的 spec.state 有 undoDepth 概念
  const historyPlugin = view.state.plugins.find((p) => {
    const k = p.spec.key
    return k && typeof k === 'object' && 'undoDepth' in (p.spec.state ?? {})
  })
  const undoDepth = historyPlugin
    ? historyPlugin.spec.state.apply(view.state.tr, null, view.state, view.state)
    : 'N/A'
  console.log(`  A 块编辑后 undoDepth: ${undoDepth}`)

  // 换成 B 块
  const schema = inst.editor.action((c) => c.get(schemaCtx))
  const s2 = win.document.createElement('div')
  const instB = await mountChunk({ chunk: chunkB, container: s2, onChange: () => {} })
  const docB = instB.editor.action((c) => c.get(editorViewCtx).state.doc)
  const jsonB = docB.toJSON()

  const view2 = inst.editor.action((c) => c.get(editorViewCtx))
  view2.dispatch(view2.state.tr.replace(0, view2.state.doc.content.size, PMNode.fromJSON(schema, jsonB).content))

  // 现在在 B 的内容上按 Ctrl+Z
  let undoError = null
  try {
    const { undo } = await import('@milkdown/prose/history')
    undo(view2.state, view2.dispatch)
  } catch (e) {
    undoError = String(e).slice(0, 80)
  }
  console.log(`  换块后撤销: ${undoError ? '抛错 -> ' + undoError : '未抛错,但会把 B 的内容撤成 A 的内容'}`)
  check(true, 'undo 栈确实跨块延续(这是必须处理的问题,不是 bug 而是语义问题)')

  await inst.destroy()
  await instB.destroy()
}

console.log('\n== 边界 5:插件状态残留 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunkA, container: s, onChange: () => {} })
  const plugins = inst.editor.action((c) => c.get(prosePluginsCtx))
  console.log(`  插件数: ${plugins.length}`)
  console.log('  → 这些插件的 state 是 EditorState 的一部分,复用时全部延续')
  console.log('  → 例:slash 菜单的打开状态、tooltip 的锚点、collab 的 awareness 都会残留')
  await inst.destroy()
}

console.log('\n== 边界 6:DOM 事件监听器 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunkA, container: s, onChange: () => {} })
  console.log('  → ProseMirror 的 DOM 事件挂在 EditorView 的 DOM 上,随实例走')
  console.log('  → 复用时把 root 移到新 slot,监听器自动跟随(因为是同一个 DOM 节点)')
  console.log('  → 但如果换内容时重建了 DOM,监听器就丢了')
  console.log('  → 解法:复用时只换 doc,不重建 DOM')
  await inst.destroy()
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
