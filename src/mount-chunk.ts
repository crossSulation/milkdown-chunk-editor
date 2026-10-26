/**
 * 单块编辑器实例的挂载与销毁。
 *
 * 核心约束:Milkdown 的 Editor 是重量级对象(EditorState + EditorView + 插件图),
 * 不能一次性创建几十个。策略是按视口懒挂载,滚出即销毁,
 * 销毁前必须把 markdown 序列化回 ChunkStore —— 否则内容丢失。
 *
 * 性能设计(见 doc-cache.ts):
 *   1. dirty 标记 —— 只有内容真的被改过才回写,避免「只是滚了一下」就付出
 *      remark stringify 的代价(实测 8.7ms/3000 字符)
 *   2. JSON 缓存 —— 挂载时若 doc JSON 缓存命中,直接注入 {type:'json'},
 *      跳过 remark parse(实测 5.4ms/3000 字符)
 */

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  serializerCtx,
  prosePluginsCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { Plugin, PluginKey } from '@milkdown/prose/state';

import type { Chunk } from './split';

/**
 * 内容变更检测插件。
 *
 * 为什么不直接用 @milkdown/plugin-listener 的 updated:
 * listener 插件内部对 updated 做了 200ms debounce,且用 prevDoc.eq(doc)
 * 判断变化 —— 这意味着「文档是否被改过」这个信号本身就延迟 200ms,
 * 而我们需要在卸载的瞬间准确知道 dirty 状态,否则可能丢内容。
 *
 * 直接挂 ProseMirror 插件监听 tr.docChanged:
 *   - 立即触发,无延迟
 *   - 语义精确:只有真正改了文档才置 dirty
 *   - 标记 addToHistory=false 的事务(如 setMeta)也会跳过,与 listener 行为一致
 */
const dirtyKey = new PluginKey('MILKDOWN_CHUNK_DIRTY');

function createDirtyPlugin(onChange: () => void) {
  return new Plugin({
    key: dirtyKey,
    state: {
      init: () => {},
      apply: (tr) => {
        if (!tr.docChanged) return;
        if (tr.getMeta('addToHistory') === false) return;
        onChange();
      },
    },
  });
}

export interface MountOptions {
  chunk: Chunk;
  container: HTMLElement;
  /** 防抖后的内容回写 */
  onChange: (chunkId: string, markdown: string) => void;
  editable?: boolean;
  /**
   * 预解析的 doc JSON。传入后 Milkdown 会走 Node.fromJSON 路径,
   * 完全跳过 remark 解析。schema 不兼容时会抛错并自动回退。
   */
  cachedJson?: unknown;
}

export interface MountedChunk {
  chunkId: string;
  editor: Editor;
  root: HTMLElement;
  /** 内容是否被编辑过(未编辑则无需序列化回写) */
  readonly dirty: boolean;
  /** 立即序列化当前内容并回写,用于销毁前兜底 */
  flush: () => void;
  destroy: () => Promise<void>;
}

export async function mountChunk(opts: MountOptions): Promise<MountedChunk> {
  const { chunk, container, onChange, editable = true, cachedJson } = opts;

  const root = document.createElement('div');
  root.className = 'milkdown-chunk-root';
  root.dataset.chunkId = chunk.id;
  // 占位高度防止挂载瞬间滚动条塌陷
  root.style.minHeight = `${Math.round(chunk.estimatedHeight)}px`;
  container.appendChild(root);

  let debounceTimer: number | undefined;
  let destroyed = false;
  let dirty = false;

  const serialize = () => {
    try {
      return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
    } catch {
      return undefined;
    }
  };

  /** 文档被修改时立即标记,并安排一次延迟回写 */
  const markDirty = () => {
    if (destroyed) return;
    dirty = true;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(flush, 400);
  };

  const flush = () => {
    if (destroyed) return;
    window.clearTimeout(debounceTimer);
    // 内容没被改过就不必序列化 —— 这一条直接消除了「纯滚动」场景下的
    // remark stringify 开销
    if (!dirty) return;
    const md = serialize();
    if (md === undefined) return;
    dirty = false;
    onChange(chunk.id, md);
  };

  const build = (defaultValue: unknown) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, defaultValue as never);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => editable,
          attributes: {
            ...(prev?.attributes ?? {}),
            class: 'milkdown-chunk',
            spellcheck: 'false',
          },
        }));
        // 注入 dirty 检测插件
        ctx.update(prosePluginsCtx, (prev) => [...prev, createDirtyPlugin(markDirty)]);
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .create();

  let editor: Editor;
  try {
    // 优先用缓存的 doc JSON,跳过 remark 解析
    editor = cachedJson
      ? await build({ type: 'json', value: cachedJson })
      : await build(chunk.markdown);
  } catch (err) {
    // schema 不兼容等异常 → 回退到 markdown 解析路径
    if (!cachedJson) throw err;
    editor = await build(chunk.markdown);
  }

  const destroy = async () => {
    if (destroyed) return;
    // 销毁前回写,保证内容不丢
    flush();
    destroyed = true;
    window.clearTimeout(debounceTimer);
    try {
      await editor.destroy();
    } catch {
      /* 已销毁 */
    }
    root.remove();
  };

  return {
    chunkId: chunk.id,
    editor,
    root,
    get dirty() {
      return dirty;
    },
    flush,
    destroy,
  };
}
