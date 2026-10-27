/**
 * 编辑器实例池。
 *
 * 用途:滚动时避免反复创建/销毁重量级的 Milkdown Editor。
 *
 * 实测(Chromium,10 块 × 6000 字符):
 *   创建占「挂载 + 销毁」总耗时的 97%,销毁几乎免费。
 *   所以复用的收益全部来自「省掉创建」,池化本身不是重点。
 *
 * 生命周期:
 *   取出 → 挂载到 slot → 使用 → 归还(不销毁) → 再次取出时替换内容
 *
 * 已知限制:
 *   归还的实例仍持有上一个块的 undo 历史。实测用 addToHistory:false
 *   的事务替换内容后,undo 栈不会被清空 —— 在新块里按 Ctrl+Z 依然可能
 *   撤回到旧块的内容。这是语义问题,需要跨块撤销设计才能根治,
 *   池化解决不了。开启 recycle 时应在文档中明确告知用户。
 */

import type { MountedChunk } from './mount-chunk';

export interface PoolOptions {
  /** 池容量上限,超出则销毁最旧的实例 */
  maxSize?: number;
}

export class EditorPool {
  private items: MountedChunk[] = [];
  private readonly maxSize: number;

  constructor(opts: PoolOptions = {}) {
    this.maxSize = opts.maxSize ?? 3;
  }

  get size() {
    return this.items.length;
  }

  /** 取出并复用最久未使用的实例 */
  take(): MountedChunk | undefined {
    return this.items.shift();
  }

  /**
   * 归还实例。池满时销毁最早的实例。
   * 返回被销毁的实例数(便于监控)。
   */
  give(instance: MountedChunk): number {
    this.items.push(instance);
    let destroyed = 0;
    while (this.items.length > this.maxSize) {
      const oldest = this.items.shift();
      if (!oldest) break;
      void oldest.destroy();
      destroyed++;
    }
    return destroyed;
  }

  /** 清空并销毁所有实例 */
  clear() {
    const items = this.items;
    this.items = [];
    for (const item of items) void item.destroy();
  }
}
