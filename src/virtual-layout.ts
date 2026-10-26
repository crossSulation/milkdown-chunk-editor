/**
 * 视口层:高度表驱动的虚拟滚动。
 *
 * 不依赖任何虚拟列表库(React/Vue 生态的虚拟列表假设子元素高度可控,
 * 而 ProseMirror 内部 DOM 结构不可干预)。
 * 这里自己维护高度表 + 二分查找可见区间。
 *
 * 数据结构选型:Fenwick Tree(树状数组)
 *   需求是「单点高度更新」+「前缀和查询」+「按位置反查块下标」。
 *   - 数组前缀和:更新 O(n),查询 O(1),反查 O(log n)
 *   - Fenwick Tree:更新 O(log n),查询 O(log n),反查 O(log n)
 *   高度回填在滚动中频繁发生,更新是热点,所以选 Fenwick。
 *
 *   注意:本类对外仍暴露 O(1) 的 `getBox(id).top`,内部通过
 *   「脏标记 + 惰性重建 top 数组」保证读取不退化成 O(log n)。
 *   top 数组只在高度变化后重建一次(那次已经是 O(n) 的批量操作),
 *   随后的连续读取都是 O(1)。
 */

/** 树状数组:支持 O(log n) 的单点增量更新与前缀和查询 */
class FenwickTree {
  private tree: Float64Array;
  private readonly n: number;

  constructor(heights: number[]) {
    this.n = heights.length;
    this.tree = new Float64Array(this.n + 1);
    // O(n) 建树
    for (let i = 1; i <= this.n; i++) {
      this.tree[i] += heights[i - 1];
      const parent = i + (i & -i);
      if (parent <= this.n) this.tree[parent] += this.tree[i];
    }
  }

  /** 前缀和:sum(heights[0..i]),i 为 0-based 闭区间 */
  prefixSum(i: number): number {
    let sum = 0;
    // 转成 1-based 树状数组的查询
    let x = i + 1;
    while (x > 0) {
      sum += this.tree[x];
      x -= x & -x;
    }
    return sum;
  }

  /** 增量更新:heights[i] += delta */
  add(i: number, delta: number) {
    for (let x = i + 1; x <= this.n; x += x & -x) {
      this.tree[x] += delta;
    }
  }

  /**
   * 找到最大的 i,使 prefixSum(i) <= target。
   * 即「累计高度不超过 target 的块数」。
   * 用树状数组倍增,O(log n)。
   */
  lowerBound(target: number): number {
    let pos = 0;
    let rem = target;
    // 最高二进制位
    let hb = 1;
    while (hb * 2 <= this.n) hb *= 2;
    for (let pw = hb; pw > 0; pw >>= 1) {
      const next = pos + pw;
      if (next <= this.n && this.tree[next] <= rem) {
        rem -= this.tree[next];
        pos += pw;
      }
    }
    return pos;
  }
}

export interface Box {
  id: string;
  top: number;
  height: number;
}

const EPS = 1;

export class VirtualLayout {
  private boxes: Box[] = [];
  private ids: string[] = [];
  private index = new Map<string, number>();
  /** 各块高度,Fenwick Tree 的数据源 */
  private heights: number[] = [];
  /** 树状数组,负责前缀和与位置反查 */
  private fenwick!: FenwickTree;
  /**
   * 各块的 top 偏移,提供 O(1) 读取。
   * 高度变化后标记为脏,下次访问时重建。
   */
  private tops: number[] = [];
  private topsDirty = true;

  setItems(items: { id: string; height: number }[]) {
    this.boxes = items.map((it) => ({ id: it.id, top: 0, height: it.height }));
    this.ids = items.map((it) => it.id);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.heights = items.map((it) => it.height);
    this.fenwick = new FenwickTree(this.heights);
    this.topsDirty = true;
  }

  /** 重建 top 数组,O(n)。只在高度变化后触发一次。 */
  private rebuildTops() {
    if (!this.topsDirty) return;
    this.tops = new Array(this.boxes.length);
    let acc = 0;
    for (let i = 0; i < this.boxes.length; i++) {
      this.tops[i] = acc;
      acc += this.boxes[i].height;
    }
    this.topsDirty = false;
  }

  getTotalHeight() {
    if (this.boxes.length === 0) return 0;
    return this.fenwick.prefixSum(this.boxes.length - 1);
  }

  getBox(id: string): Box | undefined {
    const i = this.index.get(id);
    if (i === undefined) return undefined;
    this.rebuildTops();
    const box = this.boxes[i];
    box.top = this.tops[i];
    return box;
  }

  /**
   * 更新单块高度。
   *
   * 原来是 O(n) 全量重算前缀和,现在:
   *   - Fenwick 增量更新 O(log n)
   *   - top 数组标脏,推迟到下次读取时重建
   *
   * 注意 top 数组的重建仍是 O(n),但它是「批量摊销」的:
   * 一次高度变化只触发一次重建,随后的连续读取都是 O(1)。
   * 相比原先「每次变化都立即重算」,滚动中的连续高度回填能省下大量重复计算。
   */
  updateHeight(id: string, height: number) {
    const i = this.index.get(id);
    if (i === undefined) return false;
    if (Math.abs(this.boxes[i].height - height) < EPS) return false;
    const delta = height - this.boxes[i].height;
    this.boxes[i].height = height;
    this.heights[i] = height;
    this.fenwick.add(i, delta);
    this.topsDirty = true;
    return true;
  }

  /**
   * 二分查找 scrollTop 落在哪个块上。
   * 条件是「块底 > scrollTop」,即 top(i+1) > scrollTop,
   * 返回第一个满足该条件的下标。
   *
   * 用树状数组倍增实现,O(log n)。
   */
  private findIndex(scrollTop: number): number {
    if (this.boxes.length === 0) return 0;
    // lowerBound 返回「累计高度 <= scrollTop 的块数」,
    // 即第一个 top > scrollTop 的块下标
    const idx = this.fenwick.lowerBound(scrollTop);
    return Math.min(idx, Math.max(0, this.boxes.length - 1));
  }

  /**
   * 计算需要真实挂载的下标区间。
   * @param scrollTop 容器滚动位置
   * @param viewportHeight 可视高度
   * @param overscan 视口外额外挂载的屏数,越大越顺滑、代价越大
   */
  getRange(scrollTop: number, viewportHeight: number, overscan = 1) {
    if (this.boxes.length === 0) return { start: 0, end: 0, items: [] as Box[] };

    const first = this.findIndex(scrollTop);
    const bottom = scrollTop + viewportHeight;

    // 找到第一个 top >= bottom 的块(即视口下边界所在的块)
    let end = first;
    while (end < this.boxes.length && this.topOf(end) < bottom) end++;

    const start = Math.max(0, first - overscan);
    const stop = Math.min(this.boxes.length, end + overscan);

    this.rebuildTops();

    const items: Box[] = [];
    for (let i = start; i < stop; i++) {
      const box = this.boxes[i];
      box.top = this.tops[i];
      items.push(box);
    }

    return { start, end: stop, items };
  }

  /** 第 i 块的 top 偏移 */
  private topOf(i: number): number {
    this.rebuildTops();
    return this.tops[i];
  }

  /** 滚动到指定块,并返回该块的实际 top 用于补偿 */
  scrollTargetFor(id: string, viewportHeight: number, align: 'start' | 'center' = 'start') {
    const box = this.getBox(id);
    if (!box) return null;
    if (align === 'center') {
      return Math.max(0, box.top - (viewportHeight - box.height) / 2);
    }
    return Math.max(0, box.top - EPS);
  }
}
