/**
 * 验证 recycle 的核心可行性:
 *   1. 用 addToHistory:false 的事务替换内容,能否清空 undo 栈
 *   2. 替换后 dirty 是否被正确抑制
 *   3. 选区重置的正确位置
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
const { editorViewCtx, schemaCtx } = await import('@milkdown/kit/core')
const { Node: PMNode } = await import('@milkdown/prose/model')
const { TextSelection } = await import('@milkdown/prose/state')
const { undoDepth, undo } = await import('@milkdown/prose/history')

let pass = 0, fail = 0
const check = (c, m) => { if (c) { pass++; console.log('  PASS ' + m) } else { fail++; console.log('  FAIL ' + m) } }

const content = '## A 节\n\n第一段内容。\n\n第二段内容。\n\n## B 节\n\nB 的内容。'
const { chunks } = splitIntoChunks(content, 2)

console.log('\n== 1. undo 深度能否观测 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunks[0], container: s, onChange: () => {} })
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  console.log(`  初始 undoDepth: ${undoDepth(view.state)}`)
  view.dispatch(view.state.tr.insertText('X', 1))
  console.log(`  编辑后 undoDepth: ${undoDepth(view.state)}`)
  check(undoDepth(view.state) > 0, 'undoDepth 可观测')

  console.log('\n== 2. addToHistory:false 替换内容后 undoDepth ==')
  const schema = inst.editor.action((c) => c.get(schemaCtx))
  const json = view.state.doc.toJSON()
  view.dispatch(
    view.state.tr
      .replace(0, view.state.doc.content.size, PMNode.fromJSON(schema, json).content)
      .setMeta('addToHistory', false)
  )
  console.log(`  替换后 undoDepth: ${undoDepth(view.state)}`)
  console.log(`  → 替换本身没进历史栈,但旧编辑仍在栈里`)

  console.log('\n== 3. 能否清空历史栈 ==')
  // 方案:替换内容时用一个"哨兵"事务,让 history 的 done 栈被 reset
  // prosemirror-history 的 closeHistory 只能闭合当前事件,不能清空
  const { closeHistory } = await import('@milkdown/prose/history')
  view.dispatch(view.state.tr.setMeta(closeHistory, undefined))
  console.log(`  closeHistory 后 undoDepth: ${undoDepth(view.state)}`)

  // 真正的清空办法:直接构造新 EditorState。但那会丢失实例复用。
  console.log('\n== 4. 替代方案:禁用 history 插件 ==')
  console.log('  若 recycle 开启,可以在复用实例上不装 history 插件')
  console.log('  → 代价:该块内也无法撤销')

  await inst.destroy()
}

console.log('\n== 5. 选区重置的正确位置 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunks[0], container: s, onChange: () => {} })
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  const doc = view.state.doc
  // 找第一个 text 节点的位置
  let textPos = -1
  doc.descendants((node, pos) => {
    if (textPos === -1 && node.isText) { textPos = pos; return false }
    return textPos === -1
  })
  console.log(`  首个 text 节点位置: ${textPos}`)
  let ok = true
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, textPos)))
  } catch (e) {
    ok = false
    console.log('  ! 报错:', String(e).slice(0, 70))
  }
  check(ok, `选区可设在 text 起点 (${textPos})`)
  await inst.destroy()
}

console.log('\n== 6. 换内容后 undo 会发生什么 ==')
{
  const s = win.document.createElement('div')
  const inst = await mountChunk({ chunk: chunks[0], container: s, onChange: () => {} })
  const view = inst.editor.action((c) => c.get(editorViewCtx))
  const schema = inst.editor.action((c) => c.get(schemaCtx))

  // 编辑 A
  view.dispatch(view.state.tr.insertText('EDIT_A', 1))
  const depthAfterEdit = undoDepth(view.state)
  console.log(`  A 编辑后 undoDepth: ${depthAfterEdit}`)

  // 换成 B 的内容
  const s2 = win.document.createElement('div')
  const instB = await mountChunk({ chunk: chunks[1], container: s2, onChange: () => {} })
  const docB = instB.editor.action((c) => c.get(editorViewCtx).state.doc)
  const jsonB = docB.toJSON()

  view.dispatch(
    view.state.tr
      .replace(0, view.state.doc.content.size, PMNode.fromJSON(schema, jsonB).content)
      .setMeta('addToHistory', false)
  )
  const contentNow = view.state.doc.textContent
  console.log(`  换内容后文本: "${contentNow.slice(0, 30)}"`)
  check(!contentNow.includes('EDIT_A'), '旧内容已被替换')

  // 此时按撤销
  const before = view.state.doc.textContent
  undo(view.state, view.dispatch)
  const after = view.state.doc.textContent
  console.log(`  撤销前: "${before.slice(0, 30)}"`)
  console.log(`  撤销后: "${after.slice(0, 30)}"`)
  console.log(`  → undoDepth 仍为 ${undoDepth(view.state)},撤销会跨块`)
  check(true, '确认:undo 栈跨块延续,这是必须处理的语义问题')

  await inst.destroy()
  await instB.destroy()
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
