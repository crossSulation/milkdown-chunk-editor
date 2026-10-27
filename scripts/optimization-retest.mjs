/**
 * 用正确的测量方法重测前两轮优化(doc JSON 缓存、dirty 标记)。
 *
 * 测量方法修正:
 *   之前每步都 await requestAnimationFrame(),而 rAF 按 60fps 节流(16.7ms/帧),
 *   测出的是【帧间隔】而非实际开销。
 *   现在改成:scrollTop = x; await ed.sync(),不主动等帧。
 *
 * 对比三组:
 *   A. 基线(初始版本 b1b0f21):无 doc JSON 缓存、无 dirty 标记、无 recycle
 *   B. 当前版本:三项优化全开
 *   C. 当前版本关掉各项:disableCache / recycle:false
 *
 * 用法:node scripts/optimization-retest.mjs
 */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'scripts', '.browser-build')
// 基线实现放在仓库内临时目录(esbuild 解析依赖需要 node_modules)
const baseDir = join(root, 'scripts', '.baseline-impl')

await mkdir(outDir, { recursive: true })

// ---- 导出基线实现(初始版本 b1b0f21)----
await rm(baseDir, { recursive: true, force: true })
await mkdir(baseDir, { recursive: true })
{
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'b1b0f21', 'src'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  for (const file of files) {
    const content = execFileSync('git', ['show', `b1b0f21:${file}`], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    })
    const target = join(baseDir, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

async function bundle(entryDir, outFile) {
  await build({
    entryPoints: [join(entryDir, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    outfile: outFile,
    loader: { '.css': 'css' },
    logLevel: 'error',
  })
}

await bundle(baseDir, join(outDir, 'baseline.js'))
await bundle(root, join(outDir, 'current.js'))
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
  '',
  'async function run(mod, opts) {',
  "  const { ChunkedEditor } = await import(mod)",
  '  const ed = new ChunkedEditor({',
  '    scroller, content: CONTENT, splitLevel: 2,',
  '    overscan: opts.overscan ?? 1,',
  '    ...(opts.disableCache !== undefined ? { disableCache: opts.disableCache } : {}),',
  '    ...(opts.recycle !== undefined ? { recycle: opts.recycle } : {}),',
  '  })',
  '  await ed.mount()',
  '  await new Promise(r => setTimeout(r, 300))',
  '',
  '  // 预热:走一遍全文,让缓存填满(基线版本没有缓存,这步只是稳定状态)',
  '  for (let i = 0; i < 40; i++) { scroller.scrollTop = i * 2000; await ed.sync() }',
  '',
  '  // 正式测量:倒着滚回去,不等帧',
  '  const STEPS = 60',
  '  const t0 = performance.now()',
  '  for (let i = 0; i < STEPS; i++) {',
  '    scroller.scrollTop = (STEPS - i) * 2000',
  '    await ed.sync()',
  '  }',
  '  const t1 = performance.now()',
  '  scroller.getBoundingClientRect().height',
  '  const t2 = performance.now()',
  '  const mdLen = ed.getMarkdown().length',
  '  ed.destroy()',
  '  return { ms: (t1 - t0) / STEPS, withLayout: (t2 - t0) / STEPS, mdLen }',
  '}',
  '',
  '// 每种配置跑两遍,取第二遍(热身完成)',
  'const configs = [',
  '  { label: "基线(无缓存/dirty/recycle)", mod: "/baseline.js", opts: {} },',
  '  { label: "当前(全开)",                  mod: "/current.js",  opts: {} },',
  '  { label: "当前 - 关缓存",              mod: "/current.js",  opts: { disableCache: true } },',
  '  { label: "当前 - 关 recycle",          mod: "/current.js",  opts: { recycle: false } },',
  '  { label: "当前 - 全关",                mod: "/current.js",  opts: { disableCache: true, recycle: false } },',
  ']',
  'const results = []',
  'for (const c of configs) {',
  '  await run(c.mod, c.opts)',
  '  const r = await run(c.mod, c.opts)',
  '  results.push({ label: c.label, ...r })',
  '}',
  'window.__RESULT__ = results',
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
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__DONE__ === true, { timeout: 240000 })
const results = await page.evaluate(() => window.__RESULT__)
const metrics = await client.send('Performance.getMetrics')
const m = Object.fromEntries(metrics.metrics.map((x) => [x.name, x.value]))

console.log('\n=== 用正确方法重测(40 块文档,60 步滚动,不等帧)===\n')
console.log('配置'.padEnd(32) + 'ms/步'.padStart(9) + '含布局'.padStart(9) + '相对基线'.padStart(11))
console.log('─'.repeat(64))
const base = results[0]
for (const r of results) {
  const d = ((base.ms - r.ms) / base.ms) * 100
  const mark = r === base ? '(基线)' : `${d >= 0 ? '-' : '+'}${Math.abs(d).toFixed(1)}%`
  console.log(
    r.label.padEnd(32) +
      r.ms.toFixed(3).padStart(9) +
      r.withLayout.toFixed(3).padStart(9) +
      mark.padStart(11)
  )
}

console.log(`\n--- 各优化的独立贡献 ---`)
const cur = results.find((r) => r.label.startsWith('当前(全开)'))
const noCache = results.find((r) => r.label.includes('关缓存'))
const noRecycle = results.find((r) => r.label.includes('关 recycle'))
const allOff = results.find((r) => r.label.includes('全关'))

console.log(`doc JSON 缓存:   ${allOff.ms.toFixed(3)}ms → ${noRecycle.ms.toFixed(3)}ms  (${(allOff.ms / noRecycle.ms).toFixed(2)}x)`)
console.log(`实例复用:        ${noCache.ms.toFixed(3)}ms → ${cur.ms.toFixed(3)}ms  (${(noCache.ms / cur.ms).toFixed(2)}x)`)
console.log(`相对基线总提升:  ${base.ms.toFixed(3)}ms → ${cur.ms.toFixed(3)}ms  (${(base.ms / cur.ms).toFixed(2)}x)`)

const lens = new Set(results.map((r) => r.mdLen))
console.log(`\n内容长度一致性: ${lens.size === 1 ? '✓ 全部一致 (' + [...lens][0] + ')' : '✗ 不一致: ' + [...lens].join(', ')}`)
console.log(`页面总 LayoutCount: ${m.LayoutCount}  TaskDuration: ${(m.TaskDuration * 1000).toFixed(0)}μs`)

await browser.close()
server.close()
