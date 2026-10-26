/**
 * contain 属性组合对照实验。
 *
 * 测量方式:预热走一遍全文(让 doc JSON 缓存填满),再倒着滚回去,
 * 全程不等 requestAnimationFrame —— rAF 按 60fps 节流,等帧测出的是
 * 帧间隔而非实际开销,会造成严重误判。
 *
 * 对照维度:contain 组合 × overscan 大小
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
const baseCss = await readFile(join(root, 'src', 'style.css'), 'utf8')

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
  'const OVERSCAN = Number(new URLSearchParams(location.search).get("overscan") || 1)',
  '',
  'async function run() {',
  '  const ed = new ChunkedEditor({ scroller, content: CONTENT, splitLevel: 2, overscan: OVERSCAN })',
  '  await ed.mount()',
  '  await new Promise(r => setTimeout(r, 400))',
  '  const mounted = scroller.querySelectorAll(".milkdown-chunk-root").length',
  '',
  '  // 预热:走一遍全文让缓存填满',
  '  for (let i = 0; i < 60; i++) { scroller.scrollTop = i * 2000; await ed.sync() }',
  '',
  '  const STEPS = 60',
  '  const t0 = performance.now()',
  '  for (let i = 0; i < STEPS; i++) { scroller.scrollTop = (STEPS - i) * 2000; await ed.sync() }',
  '  const t1 = performance.now()',
  '  scroller.getBoundingClientRect().height',
  '  const t2 = performance.now()',
  '  const mdLen = ed.getMarkdown().length',
  '  ed.destroy()',
  '  return { ms: (t1 - t0) / STEPS, withLayout: (t2 - t0) / STEPS, mounted, mdLen }',
  '}',
  '',
  'await run()',
  'const r = await run()',
  'window.__RESULT__ = r',
  'window.__DONE__ = true',
]
await writeFile(join(outDir, 'app.js'), appLines.join(NL))

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }
const browser = await chromium.launch()
const results = []

const noCv = baseCss.replace(/content-visibility: auto;/, '')

const variants = [
  { label: 'cv:auto', css: baseCss },
  { label: '无 cv', css: noCv },
  { label: 'cv:hidden', css: baseCss.replace('content-visibility: auto', 'content-visibility: hidden') },
  { label: 'cv+strict', css: baseCss + '\n.chunk-slot { contain: strict; }' },
  {
    label: 'cv+layout/style/paint',
    css: baseCss + '\n.chunk-slot { contain: layout style paint; }',
  },
]

for (const ov of [1, 8]) {
  for (const v of variants) {
    await writeFile(join(outDir, 'style.css'), v.css)
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

    const page = await browser.newPage()
    const client = await page.context().newCDPSession(page)
    await client.send('Performance.enable')
    await page.goto(`http://127.0.0.1:${port}/?overscan=${ov}`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.__DONE__ === true, { timeout: 180000 })
    const r = await page.evaluate(() => window.__RESULT__)
    const metrics = await client.send('Performance.getMetrics')
    const m = Object.fromEntries(metrics.metrics.map((x) => [x.name, x.value]))

    results.push({
      ov,
      label: v.label,
      ms: r.ms,
      withLayout: r.withLayout,
      mounted: r.mounted,
      mdLen: r.mdLen,
      taskDur: m.TaskDuration * 1000,
      layoutDur: m.LayoutDuration * 1000,
    })

    await page.close()
    server.close()
  }
}

console.log('\n=== contain / content-visibility 对照(真实 Chromium)===\n')
for (const ov of [1, 8]) {
  console.log(`--- overscan=${ov} ---`)
  console.log('方案'.padEnd(24) + 'ms/步'.padStart(9) + '含布局'.padStart(9) + '挂载'.padStart(7) + 'TaskDur'.padStart(11) + 'LayoutDur'.padStart(11))
  console.log('─'.repeat(72))
  const group = results.filter((r) => r.ov === ov)
  const base = group.find((r) => r.label === 'cv:auto')
  for (const r of group) {
    const d = ((base.ms - r.ms) / base.ms) * 100
    const mark = r.label === 'cv:auto' ? '' : `  (${d >= 0 ? '-' : '+'}${Math.abs(d).toFixed(0)}%)`
    console.log(
      r.label.padEnd(24) +
        r.ms.toFixed(3).padStart(9) +
        r.withLayout.toFixed(3).padStart(9) +
        String(r.mounted).padStart(7) +
        `${r.taskDur.toFixed(0)}μs`.padStart(11) +
        `${r.layoutDur.toFixed(0)}μs`.padStart(11) +
        mark
    )
  }
  console.log('')
}

const lens = new Set(results.map((r) => r.mdLen))
console.log(`内容长度一致性: ${lens.size === 1 ? '✓ 全部一致 (' + [...lens][0] + ')' : '✗ 不一致'}`)

await browser.close()
