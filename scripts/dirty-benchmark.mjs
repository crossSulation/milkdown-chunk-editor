/**
 * dirty 标记的专项测量。
 *
 * dirty 标记的作用:卸载块时,若内容没被编辑过,跳过 remark stringify。
 * 无 dirty 标记的版本:每次卸载都无条件 stringify。
 *
 * 做法:从当前源码派生一个变体,把 flush 里的 `if (!dirty) return;` 去掉,
 * 强制每次都序列化。其余代码完全相同,保证对比公平。
 *
 * 用法:node scripts/dirty-benchmark.mjs
 */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'scripts', '.browser-build')
const noDirtyDir = join(root, 'scripts', '.no-dirty-impl')

await mkdir(outDir, { recursive: true })

// ---- 派生「无 dirty 标记」变体 ----
// 注意:src 的内容被复制到 .no-dirty-impl/ 下,所以入口是 .no-dirty-impl/index.ts
await rm(noDirtyDir, { recursive: true, force: true })
await mkdir(noDirtyDir, { recursive: true })
await cp(join(root, 'src', 'index.ts'), join(noDirtyDir, 'index.ts'))
await cp(join(root, 'src', 'style.css'), join(noDirtyDir, 'style.css'))
for (const f of ['chunked-editor.ts', 'doc-cache.ts', 'editor-pool.ts', 'mount-chunk.ts', 'split.ts', 'virtual-layout.ts']) {
  await cp(join(root, 'src', f), join(noDirtyDir, f))
}

const mountPath = join(noDirtyDir, 'mount-chunk.ts')
let mountSrc = await readFile(mountPath, 'utf8')

// 去掉 dirty 检查:每次 flush 都无条件序列化
const before = mountSrc
mountSrc = mountSrc.replace(
  /    \/\/ 内容没被改过就不必序列化[\s\S]*?if \(!dirty\) return;\n/,
  '    // [变体] 故意去掉 dirty 检查:每次卸载都无条件 stringify\n'
)
if (mountSrc === before) {
  console.error('!! 未能定位 dirty 检查,变体未生效')
  process.exit(1)
}
await writeFile(mountPath, mountSrc)
console.log('已生成无 dirty 标记变体')

async function bundle(entryPoint, outFile) {
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    outfile: outFile,
    loader: { '.css': 'css' },
    logLevel: 'error',
  })
}
await bundle(join(noDirtyDir, 'index.ts'), join(outDir, 'nodirty.js'))
await bundle(join(root, 'src', 'index.ts'), join(outDir, 'current.js'))
await writeFile(join(outDir, 'style.css'), await readFile(join(root, 'src', 'style.css')))

const NL = String.fromCharCode(10)
const appLines = [
  'const NL = String.fromCharCode(10)',
  'const parts = []',
  'for (let i = 0; i < 40; i++) {',
  "  parts.push('## Section ' + i, '')",
  "  for (let j = 0; j < 20; j++) parts.push('This is a typical line of English text in a document body with some more words to fill the line out properly.')",
  "  parts.push('')",
  '}',
  'const CONTENT = parts.join(NL)',
  "const scroller = document.getElementById('scroller')",
  'const MOD = new URLSearchParams(location.search).get("mod")',
  'async function run() {',
  "  const { ChunkedEditor } = await import(MOD)",
  '  const ed = new ChunkedEditor({ scroller, content: CONTENT, splitLevel: 2, overscan: 1 })',
  '  await ed.mount()',
  '  await new Promise(r => setTimeout(r, 300))',
  '  // 预热:走一遍全文让缓存填满',
  '  for (let i = 0; i < 40; i++) { scroller.scrollTop = i * 2000; await ed.sync() }',
  '  const STEPS = 60',
  '  const t0 = performance.now()',
  '  for (let i = 0; i < STEPS; i++) { scroller.scrollTop = (STEPS - i) * 2000; await ed.sync() }',
  '  const t1 = performance.now()',
  '  const mdLen = ed.getMarkdown().length',
  '  ed.destroy()',
  '  return { ms: (t1 - t0) / STEPS, mdLen }',
  '}',
  'await run()',
  'const r = await run()',
  'window.__RESULT__ = r',
  'window.__DONE__ = true',
]
await writeFile(join(outDir, 'app.js'), appLines.join(NL))
await writeFile(
  join(outDir, 'index.html'),
  [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css">',
    '<style>#scroller{height:600px;overflow-y:auto}</style>',
    '</head><body><div id="scroller"></div>',
    '<script type="module" src="/app.js"></script></body></html>',
    '',
  ].join(NL)
)

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }
const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const file = join(outDir, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!existsSync(file)) {
      res.writeHead(404).end('nf')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(await readFile(file))
  })
  s.listen(0, '127.0.0.1', () => resolve(s))
})
const { port } = server.address()

const browser = await chromium.launch()
const configs = [
  { label: '有 dirty 标记', mod: '/current.js' },
  { label: '无 dirty 标记', mod: '/nodirty.js' },
]
const samples = {}
for (const c of configs) samples[c.label] = []

for (let round = 0; round < 5; round++) {
  const order = round % 2 === 0 ? configs : [...configs].reverse()
  for (const c of order) {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/?mod=${encodeURIComponent(c.mod)}`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.__DONE__ === true, { timeout: 120000 })
    const r = await page.evaluate(() => window.__RESULT__)
    samples[c.label].push(r.ms)
    await page.close()
  }
}

console.log('\n=== dirty 标记专项测量(40 块文档,60 步滚动)===\n')
console.log('版本'.padEnd(18) + '中位数'.padStart(10) + '最小'.padStart(10) + '全部样本');
console.log('─'.repeat(76))
for (const c of configs) {
  const s = [...samples[c.label]].sort((a, b) => a - b)
  const m = s[Math.floor(s.length / 2)]
  console.log(
    c.label.padEnd(18) +
      m.toFixed(3).padStart(10) +
      s[0].toFixed(3).padStart(10) +
      '  ' +
      samples[c.label].map((x) => x.toFixed(2)).join(', ')
  )
}

const med = (label) => {
  const s = [...samples[label]].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const withD = med('有 dirty 标记')
const withoutD = med('无 dirty 标记')
console.log(`\ndirty 标记的收益: ${withoutD.toFixed(3)}ms → ${withD.toFixed(3)}ms  (${(withoutD / withD).toFixed(2)}x)`)
console.log(`节省: ${(withoutD - withD).toFixed(3)} ms/步`)

await browser.close()
server.close()
