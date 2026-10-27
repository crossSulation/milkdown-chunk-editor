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
 *
 * 复用(recycle)支持:
 *   实例的创建与挂载被拆开 —— createChunkEditor 建实例,attach/detach 控制 DOM 归属。
 *   滚出视口时 detach 而非 destroy,实例进池等待复用;滚回来时复用同一实例,
 *   只替换文档内容(Node.fromJSON,不走 remark 解析)。
 */

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  serializerCtx,
  schemaCtx,
  prosePluginsCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Node as PMNode, Slice } from '@milkdown/prose/model';
import { TextSelection } from '@milkdown/prose/state';

import type { Chunk } from './split';

/**
 * 标记「本事务是内部的内容替换,不是用户编辑」。
 * dirty 插件遇到它会跳过,避免复用时把 dirty 误置为 true。
 */
export const CONTENT_REPLACE_META = 'milkdownChunkContentReplace';

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
 *   - 内部的内容替换事务通过 CONTENT_REPLACE_META 标记后会被跳过
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
        // 内部替换内容不算用户编辑
        if (tr.getMeta(CONTENT_REPLACE_META)) return;
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
  /** 从 DOM 摘除但保留实例,供后续复用 */
  detach: () => void;
  /** 挂载到新的容器 */
  attach: (container: HTMLElement) => void;
  /**
   * 替换文档内容,用于复用场景。
   * 走 Node.fromJSON + tr.replace,不走 remark 解析(实测快约 40 倍)。
   * 会重置选区到文档开头,并抑制 dirty 标记。
   *
   * @returns 替换是否成功。失败(比如 schema 不兼容)时返回 false,
   *          调用方必须丢弃这个实例并重建,否则会拿到上一个块的内容。
   */
  replaceContent: (json: unknown) => boolean;
  /**
   * 改写绑定的 chunk id。
   * 复用时同一个实例会先后承载不同的块,回写内容时必须知道当前是哪个块。
   */
  setChunkId: (id: string) => void;
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
  /** 当前绑定的 chunk id,复用时会被改写 */
  let currentChunkId = chunk.id;

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
    // [变体] 故意去掉 dirty 检查
    const md = serialize();
    if (md === undefined) return;
    dirty = false;
    onChange(currentChunkId, md);
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

  /**
   * 替换内容(复用路径)。
   *
   * 两个必须做对的地方:
   *   1. tr.replace 的第三个参数必须是 Slice,不能是裸 Fragment ——
   *      传 Fragment 会导致内容被清空
   *   2. 用 CONTENT_REPLACE_META 标记,否则 dirty 会被误置为 true,
   *      白白触发一次 remark stringify
   */
  const replaceContent = (json: unknown): boolean => {
    if (destroyed) return false;
    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      const schema = editor.action((ctx) => ctx.get(schemaCtx));
      const newDoc = PMNode.fromJSON(schema, json as never);
      const tr = view.state.tr
        .replace(
          0,
          view.state.doc.content.size,
          new Slice(newDoc.content, 0, 0)
        )
        .setMeta(CONTENT_REPLACE_META, true)
        // 替换内容不应进入 undo 栈
        .setMeta('addToHistory', false);
      view.dispatch(tr);

      // 重置选区到首个 inline 位置。
      // 不能设在 doc 顶层(位置 0),那不是 inline 节点,会抛
      // "TextSelection endpoint not pointing into a node with inline content"
      const doc = view.state.doc
      let inlinePos = 1
      doc.descendants((node, pos) => {
        if (node.isText) {
          inlinePos = pos
          return false
        }
        return true
      })
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(doc, inlinePos))
      )

      // 内容已被替换,不应残留 dirty 状态
      dirty = false
      window.clearTimeout(debounceTimer)
      return true
    } catch {
      // schema 不兼容等异常:调用方需要知道替换失败了,
      // 否则会拿着上一个块的内容当新内容用 —— 静默失败会造成数据错乱
      return false
    }
  };

  const attach = (target: HTMLElement) => {
    if (destroyed) return
    target.appendChild(root)
    root.style.minHeight = ''
  }

  const detach = () => {
    if (destroyed) return
    root.remove()
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
    detach,
    attach,
    replaceContent,
    setChunkId: (id: string) => {
      currentChunkId = id;
      root.dataset.chunkId = id;
    },
    destroy,
  };
}
