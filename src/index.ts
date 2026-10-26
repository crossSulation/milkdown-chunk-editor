export { ChunkedEditor } from './chunked-editor'
export type { ChunkedEditorOptions, OutlineItem } from './chunked-editor'

export {
  splitIntoChunks,
  joinChunks,
  buildOutline,
  estimateHeight,
} from './split'
export type { Chunk, ChunkStore } from './split'

export { VirtualLayout } from './virtual-layout'
export type { Box } from './virtual-layout'

export { mountChunk } from './mount-chunk'
export type { MountedChunk, MountOptions } from './mount-chunk'

export { DocCache, fingerprint } from './doc-cache'
export type { DocCacheEntry } from './doc-cache'