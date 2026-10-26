/**
 * 视口层:高度表驱动的虚拟滚动。
 *
 * 不依赖任何虚拟列表库(React/Vue 生态的虚拟列表假设子元素高度可控,
 * 而 ProseMirror 内部 DOM 结构不可干预)。
 * 这里自己维护 prefix-sum 高度表 + 二分查找可见区间。
 */

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
  /** 前缀和:offsets[i] = boxes[0..i-1] 的高度总和 */
  private offsets: number[] = [0];
  private total = 0;

  setItems(items: { id: string; height: number }[]) {
    this.boxes = items.map((it) => ({ id: it.id, top: 0, height: it.height }));
    this.ids = items.map((it) => it.id);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.rebuild();
  }

  private rebuild() {
    this.offsets = new Array(this.boxes.length + 1);
    this.offsets[0] = 0;
    for (let i = 0; i < this.boxes.length; i++) {
      this.boxes[i].top = this.offsets[i];
      this.offsets[i + 1] = this.offsets[i] + this.boxes[i].height;
    }
    this.total = this.offsets[this.boxes.length] ?? 0;
  }

  getTotalHeight() {
    return this.total;
  }

  getBox(id: string): Box | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.boxes[i];
  }

  /** 更新单块高度,只重建一次前缀和,O(n) 但 n 是块数不是节点数 */
  updateHeight(id: string, height: number) {
    const i = this.index.get(id);
    if (i === undefined) return false;
    if (Math.abs(this.boxes[i].height - height) < EPS) return false;
    this.boxes[i].height = height;
    this.rebuild();
    return true;
  }

/**
 * 二分查找 scrollTop 落在哪个块上。
 * 条件是「块底 > scrollTop」,即 offsets[mid+1] > scrollTop,
 * 返回第一个满足该条件的下标。
 */
private findIndex(scrollTop: number): number {
  let lo = 0;
  let hi = this.boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // offsets[mid] <= scrollTop 表示还没越过 mid 的底边,继续往右
    if (this.offsets[mid + 1] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, this.boxes.length - 1));
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
    let end = first;
    while (end < this.boxes.length && this.offsets[end] < bottom) end++;

    const start = Math.max(0, first - overscan);
    const stop = Math.min(this.boxes.length, end + overscan);

    return {
      start,
      end: stop,
      items: this.boxes.slice(start, stop),
    };
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
