/**
 * 文档缓存层:把「markdown ↔ ProseMirror doc」的转换结果缓存起来。
 *
 * 背景:分片虚拟化下,用户每滚动一屏就会卸载并重新挂载若干块。
 * 每次挂载都要走 remark parse(约 5ms/3000 字符),每次卸载都要走
 * remark stringify(约 8.7ms/3000 字符)—— 但这些块的内容往往
 * 自上次挂载以来根本没被编辑过。
 *
 * 关键优化:用「内容指纹」判断是否需要重新解析。
 *   - 指纹相同 → 直接复用缓存的 doc JSON,跳过 remark parse
 *   - 指纹不同 → 重新解析,并更新缓存
 *
 * 指纹用「内容 + 长度」的快速 hash,避免对大字符串做全量比较。
 */

import type { JSONRecord } from '@milkdown/transformer';

export interface DocCacheEntry {
  /** 指纹:内容 hash */
  fingerprint: string;
  /** 解析后的 ProseMirror doc JSON */
  json: JSONRecord;
  /** 缓存时的字节数,用于统计 */
  size: number;
}

/**
 * 快速内容指纹。
 * FNV-1a 变体,32 位。对 3KB 文本耗时约 1-2μs,
 * 相比 parse 的 5ms 可以忽略。
 */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // h *= 16777619,用位运算避免浮点
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${h.toString(36)}:${text.length}`;
}

/**
 * 文档缓存。使用 LRU 策略限制内存占用。
 *
 * 内存估算:doc JSON 大约为 markdown 文本的 1.5-3 倍(取决于标记密度)。
 * 默认上限 32MB,可通过 maxBytes 调整。
 */
export class DocCache {
  private map = new Map<string, DocCacheEntry>();
  private totalBytes = 0;

  readonly maxBytes: number;

  constructor(maxBytes = 32 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  get(chunkId: string, content: string): DocCacheEntry | undefined {
    const entry = this.map.get(chunkId);
    if (!entry) return undefined;
    // 命中后移到队尾(LRU)
    this.map.delete(chunkId);
    this.map.set(chunkId, entry);
    return entry.fingerprint === fingerprint(content) ? entry : undefined;
  }

  set(chunkId: string, content: string, json: JSONRecord) {
    const existing = this.map.get(chunkId);
    if (existing) {
      this.totalBytes -= existing.size;
      this.map.delete(chunkId);
    }

    const size = JSON.stringify(json).length;
    const entry: DocCacheEntry = {
      fingerprint: fingerprint(content),
      json,
      size,
    };
    this.map.set(chunkId, entry);
    this.totalBytes += size;

    this.evict();
  }

  private evict() {
    // 超限时从队首(最久未使用)开始淘汰
    while (this.totalBytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const entry = this.map.get(oldest.value)!;
      this.map.delete(oldest.value);
      this.totalBytes -= entry.size;
    }
  }

  has(chunkId: string) {
    return this.map.has(chunkId);
  }

  delete(chunkId: string) {
    const entry = this.map.get(chunkId);
    if (entry) {
      this.totalBytes -= entry.size;
      this.map.delete(chunkId);
    }
  }

  clear() {
    this.map.clear();
    this.totalBytes = 0;
  }

  get stats() {
    return {
      entries: this.map.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
    };
  }
}