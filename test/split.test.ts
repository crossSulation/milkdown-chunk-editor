import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitIntoChunks, joinChunks, buildOutline, estimateHeight } from '../src/split.ts'

const SAMPLE = `# 第一章 概述

这是引言段落。

## 1.1 背景

背景内容第一段。

\`\`\`js
# 这不是标题,是注释
function foo() {}
\`\`\`

## 1.2 目标

目标内容。

# 第二章 方法

方法正文。
`

const norm = (s: string) => s.replace(/\n{2,}/g, '\n\n').trim()

test('按 H1/H2 切分,不误伤代码围栏内的 #', () => {
  const { chunks } = splitIntoChunks(SAMPLE, 2)
  // L<=2 的真实标题有 4 个;围栏内的两个 # 不产生切分
  assert.equal(chunks.length, 4)
  assert.deepEqual(
    chunks.map((c) => c.title),
    ['第一章 概述', '1.1 背景', '1.2 目标', '第二章 方法']
  )
  assert.deepEqual(
    chunks.map((c) => c.level),
    [1, 2, 2, 1]
  )
  assert.deepEqual(
    chunks.map((c) => c.id),
    ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3']
  )
})

test('代码围栏内容完整保留在同一块内', () => {
  const { chunks } = splitIntoChunks(SAMPLE, 2)
  const bg = chunks.find((c) => c.title === '1.1 背景')
  assert.ok(bg)
  assert.ok(bg!.markdown.includes('```js'))
  assert.ok(bg!.markdown.includes('# 这不是标题'))
})

test('全文往返无损', () => {
  const { chunks } = splitIntoChunks(SAMPLE, 2)
  assert.equal(norm(joinChunks(chunks)), norm(SAMPLE))
})

test('首个标题之前的内容成为引言块', () => {
  const { chunks } = splitIntoChunks('开场白。\n\n# T1\n\n内容一。\n', 2)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].title, '引言')
  assert.equal(chunks[0].level, 0)
  assert.equal(chunks[0].markdown, '开场白。')
  assert.equal(chunks[1].title, 'T1')
})

test('大纲顺序与层级正确', () => {
  const { chunks } = splitIntoChunks(SAMPLE, 2)
  const outline = buildOutline(chunks)
  assert.equal(outline.length, chunks.length)
  assert.deepEqual(outline.slice(0, 3).map((o) => o.title), ['第一章 概述', '1.1 背景', '1.2 目标'])
  assert.deepEqual(outline.slice(0, 3).map((o) => o.level), [1, 2, 2])
})

test('切分粒度越大块越少', () => {
  const withL3 = SAMPLE + '\n## 2.1 细节\n\n细节。\n'
  const l2 = splitIntoChunks(withL3, 2).chunks.length
  const l3 = splitIntoChunks(withL3, 3).chunks.length
  assert.equal(l3, l2, '样本无三级标题时两者应一致')
})

test('空文档与纯文本不报错', () => {
  assert.equal(splitIntoChunks('', 2).chunks.length, 0)
  assert.equal(splitIntoChunks('只有一段文字,没有标题。', 2).chunks.length, 1)
  assert.equal(splitIntoChunks('# 只有标题', 2).chunks.length, 1)
})

test('高度预估随内容增长', () => {
  const short = estimateHeight('短')
  const long = estimateHeight('长'.repeat(2000))
  assert.ok(long > short, '长内容预估高度必须更高')
})