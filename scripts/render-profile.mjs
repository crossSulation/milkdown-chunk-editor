/**
 * 渲染侧瓶颈测量:用 CDP Performance domain 定位开销来源。
 *
 * 关注:
 *   1. LayoutCount / RecalcStyleCount / LayoutDuration
 *   2. 长任务(>50ms)分布 —— 主线程是否被阻塞
 *   3. 各阶段耗时拆分
 *
 * 用法:node scripts/render-profile.mjs
 */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'scripts', '.browser-build')
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: join(outDir, 'bundle.js'),
  loader: { '.css': 'css' },
  logLevel: 'error',
})
await writeFile(join(outDir, 'style.css'), await readFile(join(root, 'src', 'style.css')))

const NL = String.fromCharCode(10)
const appLines = [
  "import { ChunkedEditor } from '/bundle.js'",
  '',
  'const NL = String.fromCharCode(10)',
  'const parts = []',
  'for (let i = 0; i < 60; i++) {',
  "  parts.push('## Section ' + i, '')",
  "  for (let j = 0; j < 25; j++) parts.push('This is a typical line of English text in a document body with some more words to fill the line out properly.')",
  "  parts.push('')",
  '}',
  'const CONTENT = parts.join(NL)',
  "const scroller = document.getElementById('scroller')",
  '',
  '// 记录长任务',
  'window.__LONG_TASKS__ = []',
  'new PerformanceObserver((list) => {',
  "  for (const e of list.getEntries()) window.__LONG_TASKS__.push(Math.round(e.duration))",
  "}).observe({ entryTypes: ['longtask'] })",
  '',
  'async function run() {',
  '  const ed = new ChunkedEditor({ scroller, content: CONTENT, splitLevel: 2 })',
  '  await ed.mount()',
  '  await new Promise(r => setTimeout(r, 300))',
  '  const mounted = scroller.querySelectorAll(".milkdown-chunk-root").length',
  '  const domNodes = document.querySelectorAll("*").length',
  '',
  '  window.__LONG_TASKS__ = []',
  '  const STEPS = 40',
  '  const t0 = performance.now()',
  '  for (let i = 0; i < STEPS; i++) {',
  '    scroller.scrollTop = i * 2000',
  '    await new Promise(r => requestAnimationFrame(r))',
  '    await ed.sync()',
  '  }',
  '  const t1 = performance.now()',
  '  const longTasks = [...window.__LONG_TASKS__]',
  '  const totalHeight = ed.getOutline().length',
  '  ed.destroy()',
  '  return {',
  '    ms: (t1 - t0) / STEPS,',
  '    mounted,',
  '    domNodes,',
  '    totalHeight,',
  '    longTaskCount: longTasks.length,',
  '    longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,',
  '    longTaskTotal: longTasks.reduce((a, b) => a + b, 0),',
  '  }',
  '}',
  '',
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
const page = await browser.newPage()
const client = await page.context().newCDPSession(page)
await client.send('Performance.enable')
await client.send('Profiler.enable')

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__DONE__ === true, { timeout: 180000 })

const metrics = await client.send('Performance.getMetrics')
const m = Object.fromEntries(metrics.metrics.map((x) => [x.name, x.value]))
const r = await page.evaluate(() => window.__RESULT__)

console.log('\n=== 渲染侧性能画像(60 块文档)===\n')
console.log(`挂载的块数:        ${r.mounted} / ${r.totalHeight}`)
console.log(`DOM 节点总数:      ${r.domNodes}`)
console.log(`滚动耗时:          ${r.ms.toFixed(2)} ms/步`)
console.log('')
console.log('--- 浏览器内部计数 ---')
console.log(`LayoutCount:       ${m.LayoutCount}`)
console.log(`RecalcStyleCount:  ${m.RecalcStyleCount}`)
console.log(`LayoutDuration:    ${(m.LayoutDuration * 1000).toFixed(0)} μs`)
console.log(`RecalcStyleDuration: ${(m.RecalcStyleDuration * 1000).toFixed(0)} μs`)
console.log(`ScriptDuration:    ${(m.ScriptDuration * 1000).toFixed(0)} μs`)
console.log(`TaskDuration:      ${(m.TaskDuration * 1000).toFixed(0)} μs`)
console.log('')
console.log('--- 主线程长任务(>50ms)---')
console.log(`数量:              ${r.longTaskCount}`)
console.log(`最长:              ${r.longTaskMax} ms`)
console.log(`累计:              ${r.longTaskTotal} ms`)

await browser.close()
server.close()
