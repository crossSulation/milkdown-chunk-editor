import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VirtualLayout } from '../src/virtual-layout.ts'

function makeLayout(n = 1000, h = 100) {
  const layout = new VirtualLayout()
  layout.setItems(Array.from({ length: n }, (_, i) => ({ id: `c${i}`, height: h })))
  return layout
}

test('总高度与 top 计算正确', () => {
  const l = makeLayout(1000, 100)
  assert.equal(l.getTotalHeight(), 100_000)
  assert.equal(l.getBox('c0')!.top, 0)
  assert.equal(l.getBox('c10')!.top, 1000)
  assert.equal(l.getBox('c999')!.top, 99_900)
})

test('二分查找命中正确块', () => {
  const l = makeLayout()
  assert.equal(l.getRange(50_000, 800, 0).items[0].id, 'c500')
  assert.equal(l.getRange(50_050, 800, 0).items[0].id, 'c500')
  assert.equal(l.getRange(0, 800, 0).items[0].id, 'c0')
})

test('边界:正好落在块顶 / 块内 / 块底都不差一像素', () => {
  const l = makeLayout()
  assert.equal(l.getRange(10_000, 800, 0).items[0].id, 'c100', '正好等于块顶')
  assert.equal(l.getRange(10_001, 800, 0).items[0].id, 'c100', '越过块顶 1px')
  assert.equal(l.getRange(10_099, 800, 0).items[0].id, 'c100', '块内最后 1px')
  assert.equal(l.getRange(10_100, 800, 0).items[0].id, 'c101', '正好是下一个块顶')
})

test('overscan 扩展前后区间', () => {
  const l = makeLayout()
  const r0 = l.getRange(50_000, 800, 0)
  const r1 = l.getRange(50_000, 800, 1)
  assert.equal(r1.start, r0.start - 1)
  assert.equal(r1.end, r0.end + 1)
})

test('超出范围时钳制到边界,不越界', () => {
  const l = makeLayout()
  const r = l.getRange(999_999, 800, 1)
  assert.ok(r.start >= 0)
  assert.ok(r.end <= 1000)
  assert.equal(r.items.at(-1)!.id, 'c999')
  assert.equal(l.getRange(-500, 800, 0).items[0].id, 'c0')
})

test('空布局不崩溃', () => {
  const l = new VirtualLayout()
  l.setItems([])
  const r = l.getRange(0, 800, 1)
  assert.deepEqual(r, { start: 0, end: 0, items: [] })
  assert.equal(l.getTotalHeight(), 0)
})

test('高度更新后前缀和全量重算', () => {
  const l = makeLayout()
  assert.equal(l.updateHeight('c0', 300), true)
  assert.equal(l.getBox('c0')!.height, 300)
  assert.equal(l.getTotalHeight(), 100_200)
  // 后续块的 top 全部偏移 200
  assert.equal(l.getBox('c5')!.top, 300 + 100 * 4)
  assert.equal(l.getBox('c999')!.top, 100_100)
})

test('微小高度变化被去抖,不触发重算', () => {
  const l = makeLayout()
  assert.equal(l.updateHeight('c0', 300), true)
  assert.equal(l.updateHeight('c0', 300), false, '相同高度不重复触发')
  assert.equal(l.updateHeight('c0', 300.5), false, '亚像素抖动被忽略')
})

test('更新不存在的 id 是安全的', () => {
  const l = makeLayout()
  assert.equal(l.updateHeight('nope', 100), false)
  assert.equal(l.getBox('nope'), undefined)
})

test('scrollTargetFor 对齐计算正确', () => {
  const l = makeLayout()
  assert.equal(l.scrollTargetFor('c500', 800), 50_000 - 1)
  assert.equal(l.scrollTargetFor('c500', 800, 'center'), 50_000 - (800 - 100) / 2)
  assert.equal(l.scrollTargetFor('c0', 800), 0, '首块不会被滚成负值')
  assert.equal(l.scrollTargetFor('nope', 800), null)
})