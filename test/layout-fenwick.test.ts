/**
 * 布局层测试:Fenwick Tree 改造后的等价性与边界。
 *
 * 重点:改造后必须与原「数组前缀和 + 二分」实现行为完全一致,
 * 包括边界(一像素误差)、空布局、越界查询等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VirtualLayout } from '../src/virtual-layout.ts'

/** 参考实现:原数组前缀和版本,用于交叉验证 */
class RefLayout {
  private boxes: { id: string; top: number; height: number }[] = []
  private index = new Map<string, number>()
  private offsets: number[] = [0]

  setItems(items: { id: string; height: number }[]) {
    this.boxes = items.map((it) => ({ id: it.id, top: 0, height: it.height }))
    this.index = new Map(items.map((it, i) => [it.id, i]))
    this.rebuild()
  }
  private rebuild() {
    this.offsets = new Array(this.boxes.length + 1)
    this.offsets[0] = 0
    for (let i = 0; i < this.boxes.length; i++) {
      this.boxes[i].top = this.offsets[i]
      this.offsets[i + 1] = this.offsets[i] + this.boxes[i].height
    }
  }
  getTotalHeight() {
    return this.offsets[this.boxes.length] ?? 0
  }
  getBox(id: string) {
    const i = this.index.get(id)
    return i === undefined ? undefined : this.boxes[i]
  }
  updateHeight(id: string, height: number) {
    const i = this.index.get(id)
    if (i === undefined) return false
    if (Math.abs(this.boxes[i].height - height) < 1) return false
    this.boxes[i].height = height
    this.rebuild()
    return true
  }
  private findIndex(scrollTop: number): number {
    let lo = 0
    let hi = this.boxes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.offsets[mid + 1] <= scrollTop) lo = mid + 1
      else hi = mid
    }
    return Math.min(lo, Math.max(0, this.boxes.length - 1))
  }
  getRange(scrollTop: number, viewportHeight: number, overscan = 1) {
    if (this.boxes.length === 0) return { start: 0, end: 0, items: [] }
    const first = this.findIndex(scrollTop)
    const bottom = scrollTop + viewportHeight
    let end = first
    while (end < this.boxes.length && this.offsets[end] < bottom) end++
    const start = Math.max(0, first - overscan)
    const stop = Math.min(this.boxes.length, end + overscan)
    return { start, end: stop, items: this.boxes.slice(start, stop) }
  }
}

test('Fenwick 版与参考实现在各种高度分布下完全一致', () => {
  const distributions: number[][] = [
    Array(500).fill(100),
    Array.from({ length: 350 }, (_, i) => [50, 80, 120, 30, 200, 60, 90][i % 7]),
    Array.from({ length: 257 }, (_, i) => ((i * 37) % 211) + 10),
    Array.from({ length: 1000 }, (_, i) => 1 + ((i * 7919) % 500)),
  ]

  for (const heights of distributions) {
    const items = heights.map((h, i) => ({ id: `c${i}`, height: h }))
    const ref = new RefLayout()
    const now = new VirtualLayout()
    ref.setItems(items)
    now.setItems(items)

    assert.equal(now.getTotalHeight(), ref.getTotalHeight(), '总高度一致')

    // 遍历所有滚动位置,比对可见区间
    const total = ref.getTotalHeight()
    for (let t = 0; t <= total; t += 13) {
      const a = ref.getRange(t, 800, 1)
      const b = now.getRange(t, 800, 1)
      assert.equal(b.start, a.start, `start 一致 @${t}`)
      assert.equal(b.end, a.end, `end 一致 @${t}`)
      assert.deepEqual(
        b.items.map((x) => x.id),
        a.items.map((x) => x.id),
        `可见块一致 @${t}`
      )
      assert.deepEqual(
        b.items.map((x) => x.top),
        a.items.map((x) => x.top),
        `top 一致 @${t}`
      )
    }
  }
})

test('增量更新后仍与参考实现一致', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, height: 100 }))
  const ref = new RefLayout()
  const now = new VirtualLayout()
  ref.setItems(items)
  now.setItems(items)

  for (let round = 0; round < 20; round++) {
    const idx = (round * 13) % items.length
    const newH = 50 + (round * 37) % 300
    const refRet = ref.updateHeight(`c${idx}`, newH)
    const nowRet = now.updateHeight(`c${idx}`, newH)
    assert.equal(nowRet, refRet, `更新返回值一致 @round ${round}`)

    assert.equal(now.getTotalHeight(), ref.getTotalHeight(), '总高度一致')

    // 抽查若干位置的区间
    for (const t of [0, 500, 5000, 12000, 19999]) {
      const a = ref.getRange(t, 800, 1)
      const b = now.getRange(t, 800, 1)
      assert.deepEqual(
        b.items.map((x) => x.id),
        a.items.map((x) => x.id),
        `区间一致 @${t} round ${round}`
      )
    }
  }
})

test('top 数组的脏标记机制正确', () => {
  const l = new VirtualLayout()
  l.setItems([
    { id: 'a', height: 100 },
    { id: 'b', height: 100 },
    { id: 'c', height: 100 },
  ])
  assert.equal(l.getBox('b')!.top, 100)

  // 更新第一块后,后续块的 top 应整体偏移
  l.updateHeight('a', 200)
  assert.equal(l.getBox('a')!.height, 200)
  assert.equal(l.getBox('b')!.top, 200, '后续块 top 已偏移')
  assert.equal(l.getBox('c')!.top, 300)
  assert.equal(l.getTotalHeight(), 400)

  // 连续读取不应重复重建
  const t1 = l.getBox('c')!.top
  const t2 = l.getBox('c')!.top
  assert.equal(t1, t2)
})

test('空布局与单块布局', () => {
  const empty = new VirtualLayout()
  empty.setItems([])
  assert.equal(empty.getTotalHeight(), 0)
  assert.deepEqual(empty.getRange(0, 800, 1), { start: 0, end: 0, items: [] })

  const single = new VirtualLayout()
  single.setItems([{ id: 'only', height: 50 }])
  assert.equal(single.getTotalHeight(), 50)
  assert.equal(single.getBox('only')!.top, 0)
  assert.equal(single.getRange(0, 800, 0).items.length, 1)
  assert.equal(single.getRange(1000, 800, 0).items[0].id, 'only')
})

test('高度为 0 的块会被跳过(与原实现一致)', () => {
  const l = new VirtualLayout()
  l.setItems([
    { id: 'a', height: 0 },
    { id: 'b', height: 100 },
  ])
  assert.equal(l.getTotalHeight(), 100)
  assert.equal(l.getBox('b')!.top, 0, '零高度块不占空间')

  // 零高度块在 findIndex 时会被跳过 —— 这是原实现就有的行为,
  // 因为 offsets[1] === 0 <= scrollTop(0),二分直接跳到下一块。
  const ref = new RefLayout()
  ref.setItems([
    { id: 'a', height: 0 },
    { id: 'b', height: 100 },
  ])
  const r = l.getRange(0, 800, 0)
  const refR = ref.getRange(0, 800, 0)
  assert.deepEqual(
    r.items.map((x) => x.id),
    refR.items.map((x) => x.id),
    '与参考实现行为一致'
  )
  assert.equal(r.items[0].id, 'b', '零高度块被跳过')
})
