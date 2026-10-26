/**
 * VirtualLayout 纯计算性能对照:O(n) 前缀和 vs Fenwick Tree。
 *
 * 不涉及浏览器,只测数据结构本身。
 * 用法:node scripts/layout-bench.mjs
 */
import { VirtualLayout } from '../src/virtual-layout.ts'

const NL = String.fromCharCode(10)

/** 旧实现:数组前缀和 + 全量重算 */
class OldLayout {
  private boxes: { id: string; top: number; height: number }[] = []
  private ids: string[] = []
  private index = new Map<string, number>()
  private offsets: number[] = [0]
  private total = 0

  setItems(items: { id: string; height: number }[]) {
    this.boxes = items.map((it) => ({ id: it.id, top: 0, height: it.height }))
    this.ids = items.map((it) => it.id)
    this.index = new Map(this.ids.map((id, i) => [id, i]))
    this.rebuild()
  }
  private rebuild() {
    this.offsets = new Array(this.boxes.length + 1)
    this.offsets[0] = 0
    for (let i = 0; i < this.boxes.length; i++) {
      this.boxes[i].top = this.offsets[i]
      this.offsets[i + 1] = this.offsets[i] + this.boxes[i].height
    }
    this.total = this.offsets[this.boxes.length] ?? 0
  }
  getTotalHeight() { return this.total }
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

function makeItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    height: 100 + ((i * 37) % 200),
  }))
}

function bench(layout: any, items: any[], rounds: number) {
  // 预热
  for (let i = 0; i < 50; i++) {
    layout.updateHeight(items[i % items.length].id, 150 + (i % 50))
    layout.getRange(i * 1000, 800, 1)
  }

  const t0 = process.hrtime.bigint()
  for (let r = 0; r < rounds; r++) {
    // 模拟滚动:更新若干块高度 + 查询区间
    for (let k = 0; k < 10; k++) {
      const idx = (r * 10 + k) % items.length
      layout.updateHeight(items[idx].id, 150 + (k % 50))
    }
    layout.getRange(r * 1000, 800, 1)
  }
  const t1 = process.hrtime.bigint()
  return Number(t1 - t0) / 1e6 / rounds
}

console.log('=== VirtualLayout 纯计算性能 ===\n')
console.log('块数      旧实现(ms/轮)   新实现(ms/轮)    加速比')
console.log('─'.repeat(52))

for (const n of [100, 1000, 5000, 20000, 100000]) {
  const items = makeItems(n)
  const oldL = new OldLayout()
  const newL = new VirtualLayout()
  oldL.setItems(items)
  newL.setItems(items)

  const rounds = n > 20000 ? 200 : 2000
  const oldMs = bench(oldL, items, rounds)
  const newMs = bench(newL, items, rounds)
  console.log(
    `${String(n).padStart(7)}   ${oldMs.toFixed(4).padStart(12)}   ${newMs.toFixed(4).padStart(12)}   ${(oldMs / newMs).toFixed(1)}x`
  )
}

console.log('\n=== 单次高度更新的成本 ===\n')
console.log('块数      旧实现(μs)     新实现(μs)      加速比')
console.log('─'.repeat(50))
for (const n of [100, 1000, 10000, 100000]) {
  const items = makeItems(n)
  const oldL = new OldLayout()
  const newL = new VirtualLayout()
  oldL.setItems(items)
  newL.setItems(items)

  const N = 2000
  // 预热
  for (let i = 0; i < 100; i++) oldL.updateHeight(items[i % n].id, 150 + i % 50)
  for (let i = 0; i < 100; i++) newL.updateHeight(items[i % n].id, 150 + i % 50)

  const t0 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) oldL.updateHeight(items[i % n].id, 150 + (i % 50))
  const t1 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) newL.updateHeight(items[i % n].id, 150 + (i % 50))
  const t2 = process.hrtime.bigint()

  const oldUs = Number(t1 - t0) / 1e3 / N
  const newUs = Number(t2 - t1) / 1e3 / N
  console.log(
    `${String(n).padStart(7)}   ${oldUs.toFixed(2).padStart(11)}   ${newUs.toFixed(2).padStart(11)}   ${(oldUs / newUs).toFixed(1)}x`
  )
}
