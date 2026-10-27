/**
 * 分片层:把整篇 markdown 切成若干 Chunk。
 * 只在打开文档时执行一次,不随编辑重复运行。
 */

export interface Chunk {
  id: string;
  /** 该块在整篇中的序号 */
  index: number;
  /** 标题文本,用于大纲和目录 */
  title: string;
  /** 标题层级 1-6 */
  level: number;
  /** 该块的 markdown 正文 */
  markdown: string;
  /** 预估高度(px),用于虚拟列表占位 */
  estimatedHeight: number;
  /** 上次渲染后的真实高度 */
  measuredHeight?: number;
}

export interface ChunkStore {
  chunks: Chunk[];
  byId: Map<string, Chunk>;
}

/** 标题行匹配:捕获 # 级别、标题文本 */
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/** 代码围栏状态机:围栏内部的 # 不是标题 */
function isInFence(line: string, state: { fence: string | null }): boolean {
  const m = /^(\s*)(`{3,}|~{3,})/.exec(line);
  if (m) {
    const marker = m[2][0];
    if (state.fence === null) {
      state.fence = marker;
      return true;
    }
    if (state.fence === marker) {
      state.fence = null;
    }
    return true;
  }
  return state.fence !== null;
}

const AVG_LINE_HEIGHT = 26;
const CHARS_PER_LINE = 42;
const CHUNK_PADDING = 32;

/** 按字符数粗估渲染高度,误差由 measuredHeight 校正 */
export function estimateHeight(markdown: string): number {
  const lines = markdown.split('\n');
  let units = 0;
  for (const line of lines) {
    units += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
  }
  return units * AVG_LINE_HEIGHT + CHUNK_PADDING;
}

/**
 * 按标题切分。level 表示切分粒度:
 *   1 = 只按一级标题切(章节级)
 *   2 = 按一二级标题切(小节级,推荐默认)
 *   3 = 更细
 * 前置的引言内容(第一个标题之前)会成为一个 level=0 的引导块。
 */
export function splitIntoChunks(markdown: string, level = 2): ChunkStore {
  const lines = markdown.split('\n');
  const fence = { fence: null as string | null };
  const chunks: Chunk[] = [];

  let buffer: string[] = [];
  let current: { level: number; title: string } | null = null;

  const flush = () => {
    const md = buffer.join('\n').trim();
    buffer = [];
    if (!md) return;
    const index = chunks.length;
    chunks.push({
      id: `chunk-${index}`,
      index,
      title: current?.title ?? '引言',
      level: current?.level ?? 0,
      markdown: md,
      estimatedHeight: estimateHeight(md),
    });
  };

  for (const line of lines) {
    if (isInFence(line, fence)) {
      buffer.push(line);
      continue;
    }

    const m = HEADING.exec(line);
    if (m && m[1].length <= level) {
      flush();
      current = { level: m[1].length, title: m[2] };
      // 标题留在本块内,保证每块都是完整可解析的 markdown
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return { chunks, byId: new Map(chunks.map((c) => [c.id, c])) };
}

/** 拼接全文,用于保存 / 导出 / 复制 */
export function joinChunks(chunks: Chunk[]): string {
  return chunks.map((c) => c.markdown).join('\n\n');
}

/** 重建大纲树,只读标题,不触碰正文 */
export function buildOutline(chunks: Chunk[]) {
  return chunks.map((c) => ({
    id: c.id,
    index: c.index,
    title: c.title,
    level: c.level,
  }));
}