/**
 * 编排层:把分片 + 虚拟布局 + 实例生命周期串成一个可用的滚动编辑器。
 *
 * 用法:
 *   const editor = new ChunkedEditor({ scroller, content: markdown, splitLevel: 2 });
 *   await editor.mount();
 *   editor.destroy();
 */

import { VirtualLayout } from './virtual-layout';
import { mountChunk, type MountedChunk } from './mount-chunk';
import { splitIntoChunks, joinChunks, buildOutline, type ChunkStore } from './split';
import { DocCache } from './doc-cache';
import { editorViewCtx } from '@milkdown/kit/core';

export interface OutlineItem {
  id: string;
  index: number;
  title: string;
  level: number;
}

export interface ChunkedEditorOptions {
  /** 滚动容器,必须是 position: relative 且有确定高度 */
  scroller: HTMLElement;
  /** 初始 markdown */
  content: string;
  /** 切分粒度,1=章节 2=小节(默认) */
  splitLevel?: number;
  /** 视口外额外挂载屏数 */
  overscan?: number;
  /** 内容变化回调,返回整篇 markdown */
  onSave?: (markdown: string) => void;
  /** 大纲变化回调 */
  onOutline?: (outline: OutlineItem[]) => void;
  /** doc 缓存上限(字节),默认 32MB */
  cacheBytes?: number;
  /** 关闭 doc 缓存,每次挂载都走 markdown 解析 */
  disableCache?: boolean;
}

export class ChunkedEditor {
  private store: ChunkStore;
  private layout = new VirtualLayout();
  private mounted = new Map<string, MountedChunk>();
  /** 正在挂载中的块,用于去重,防止同一块被挂载两次 */
  private inflight = new Map<string, Promise<MountedChunk>>();
  private slots = new Map<string, HTMLElement>();
  private cache = new DocCache();
  private spacer: HTMLElement;
  private ro?: ResizeObserver;
  private frame = 0;
  private disposed = false;
  /** sync 是否正在执行,防止重入 */
  private syncing = false;
  /** 重入期间是否有新的同步请求 */
  private syncPending = false;

  private readonly scroller: HTMLElement;
  private readonly overscan: number;
  private readonly onSave?: (md: string) => void;
  private readonly onOutline?: (o: OutlineItem[]) => void;
  private readonly disableCache: boolean;

  constructor(opts: ChunkedEditorOptions) {
    this.scroller = opts.scroller;
    this.overscan = opts.overscan ?? 1;
    this.onSave = opts.onSave;
    this.onOutline = opts.onOutline;
    this.disableCache = opts.disableCache ?? false;

    this.store = splitIntoChunks(opts.content ?? '', opts.splitLevel ?? 2);
    this.layout.setItems(
      this.store.chunks.map((c) => ({ id: c.id, height: c.estimatedHeight }))
    );

    this.cache = new DocCache(opts.cacheBytes ?? 32 * 1024 * 1024);

    this.spacer = document.createElement('div');
    this.spacer.className = 'chunked-spacer';
    this.spacer.style.position = 'absolute';
    this.spacer.style.left = '0';
    this.spacer.style.right = '0';
    this.spacer.style.top = '0';
    this.spacer.style.height = '0px';
    this.spacer.style.pointerEvents = 'none';
    this.scroller.appendChild(this.spacer);

    if (getComputedStyle(this.scroller).position === 'static') {
      this.scroller.style.position = 'relative';
    }
  }

  async mount() {
    if (this.disposed) return;

    this.spacer.style.height = `${this.layout.getTotalHeight()}px`;

    this.ro = new ResizeObserver(() => void this.sync());
    this.ro.observe(this.scroller);
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });

    await this.sync();
    this.onOutline?.(buildOutline(this.store.chunks));
  }

  private onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      void this.sync();
    });
  };

  /**
   * 同步入口。加了重入保护:
   * 滚动事件与 ResizeObserver 都可能触发 sync,若不加保护,
   * 第二次 sync 会在第一次 await mountChunk 期间进入,
   * 此时 mounted 还没写入 → 同一块被挂载两个实例。
   */
  async sync() {
    if (this.disposed) return;
    if (this.syncing) {
      // 标记需要再跑一轮,避免丢失这次的状态变化
      this.syncPending = true;
      return;
    }

    this.syncing = true;
    try {
      do {
        this.syncPending = false;
        await this.doSync();
      } while (this.syncPending && !this.disposed);
    } finally {
      this.syncing = false;
    }
  }

  /** 核心同步:计算可见区间 → 挂载/卸载实例 */
  private async doSync() {
    if (this.disposed) return;

    const scrollTop = this.scroller.scrollTop;
    const viewportHeight = this.scroller.clientHeight;
    const { items } = this.layout.getRange(scrollTop, viewportHeight, this.overscan);
    if (items.length === 0) return;

    const visibleIds = new Set(items.map((i) => i.id));

    // 1. 卸载不再需要的实例(销毁前会 flush 内容回 store)
    for (const [id, inst] of [...this.mounted]) {
      if (visibleIds.has(id)) continue;
      this.mounted.delete(id);
      this.slots.get(id)?.remove();
      this.slots.delete(id);
      void inst.destroy();
    }

    // 2. 挂载缺失的实例 —— 并行,避免串行 await 叠加耗时
    const pending: Promise<void>[] = [];
    for (const box of items) {
      if (this.mounted.has(box.id)) continue;
      // 已在挂载中,跳过(去重的第二道保险)
      if (this.inflight.has(box.id)) continue;
      const chunk = this.store.byId.get(box.id);
      if (!chunk) continue;

      const slot = document.createElement('div');
      slot.className = 'chunk-slot';
      slot.dataset.slotFor = box.id;
      slot.style.position = 'absolute';
      slot.style.left = '0';
      slot.style.right = '0';
      slot.style.top = `${box.top}px`;
      // 已挂载但屏外的块跳过绘制/布局,滚动接近时浏览器自动恢复。
      // 用 auto 而不是 hidden:hidden 会破坏 find-in-page 和无障碍树。
      slot.style.contentVisibility = 'auto';
      slot.style.containIntrinsicSize = `${Math.round(box.height)}px`;
      this.scroller.appendChild(slot);
      this.slots.set(box.id, slot);

      pending.push(this.mountOne(box.id, chunk, slot, visibleIds));
    }

    // 并行等待所有挂载完成
    if (pending.length > 0) await Promise.all(pending);

    // 3. 高度修正后重新贴位
    this.reposition();
  }

  private async mountOne(
    chunkId: string,
    chunk: (typeof this.store.chunks)[number],
    slot: HTMLElement,
    visibleIds: Set<string>
  ) {
    // 命中缓存则跳过 remark 解析
    const cached = this.disableCache
      ? undefined
      : this.cache.get(chunkId, chunk.markdown);

    const promise = mountChunk({
      chunk,
      container: slot,
      onChange: this.handleChunkChange,
      cachedJson: cached?.json,
    });

    this.inflight.set(chunkId, promise);

    try {
      const inst = await promise;

      // await 期间用户可能已滚走,此时必须立刻回收这一块。
      // 注意用 continue 而非 return —— 否则后续块永远不会被挂载。
      if (this.disposed || !this.store.byId.has(chunkId) || !visibleIds.has(chunkId)) {
        void inst.destroy();
        slot.remove();
        this.slots.delete(chunkId);
        return;
      }
      this.mounted.set(chunkId, inst);

      // 回填缓存:把当前 doc 的 JSON 存下来,下次挂载直接复用
      if (!this.disableCache) this.updateCache(chunkId, inst);

      requestAnimationFrame(() => this.measure(chunkId, slot));
    } catch (err) {
      slot.remove();
      this.slots.delete(chunkId);
      throw err;
    } finally {
      this.inflight.delete(chunkId);
    }
  }

  /** 把实例当前的 doc JSON 写入缓存 */
  private updateCache(chunkId: string, inst: MountedChunk) {
    try {
      const doc = inst.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
      this.cache.set(chunkId, this.store.byId.get(chunkId)?.markdown ?? '', doc.toJSON());
    } catch {
      /* 实例可能已被释放 */
    }
  }

  /** 实测高度回填,并做滚动锚定补偿 */
  private measure(chunkId: string, slot: HTMLElement) {
    const h = slot.getBoundingClientRect().height;
    if (h <= 0) return;

    const before = this.layout.getBox(chunkId);
    if (!before) return;

    // 只处理「比预估矮」的情况。
    // 变高需要把下方所有内容往下推,会打断正在阅读的视线;
    // 变矮只影响自身,补上差额并同步滚动位置即可,视觉上无感。
    if (h >= before.height) return;

    // 该块整体位于视口上方时,高度变化必须同步补偿 scrollTop,
    // 否则视口内容会瞬间跳动。判断依据是块底是否在滚动位置之上。
    const scrollTop = this.scroller.scrollTop;
    const isAboveViewport = before.top + before.height <= scrollTop;

    if (!this.layout.updateHeight(chunkId, h)) return;

    this.spacer.style.height = `${this.layout.getTotalHeight()}px`;
    this.reposition();

    if (isAboveViewport) {
      this.scroller.scrollTop = Math.max(0, scrollTop - (before.height - h));
    }
  }

  private handleChunkChange = (chunkId: string, markdown: string) => {
    const chunk = this.store.byId.get(chunkId);
    if (!chunk || chunk.markdown === markdown) return;
    chunk.markdown = markdown;
    // 内容变了,缓存的 JSON 已失效
    this.cache.delete(chunkId);
    this.onSave?.(joinChunks(this.store.chunks));
  };

  private reposition() {
    for (const [id, slot] of this.slots) {
      const box = this.layout.getBox(id);
      if (box) slot.style.top = `${box.top}px`;
    }
  }

  /** 跳转到指定块(大纲点击) */
  scrollToChunk(chunkId: string, align: 'start' | 'center' = 'start') {
    const target = this.layout.scrollTargetFor(chunkId, this.scroller.clientHeight, align);
    if (target === null) return;
    this.scroller.scrollTo({ top: target, behavior: 'smooth' });
  }

  getMarkdown(): string {
    // 强制所有已挂载实例回写,保证导出一致
    for (const inst of this.mounted.values()) inst.flush();
    return joinChunks(this.store.chunks);
  }

  getOutline() {
    return buildOutline(this.store.chunks);
  }

  /** 缓存统计,用于调试与监控 */
  get cacheStats() {
    return this.cache.stats;
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.ro?.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    for (const inst of this.mounted.values()) void inst.destroy();
    this.mounted.clear();
    this.slots.clear();
    this.inflight.clear();
    this.cache.clear();
    this.spacer.remove();
  }
}
