/**
 * 真实浏览器验证:批量测量的效果。
 *
 * 关注两个指标:
 *   1. getBoundingClientRect 的调用次数(每次都可能触发强制 reflow)
 *   2. 滚动过程中的总耗时
 *
 * 通过注入包装 getBoundingClientRect 来计数。
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

console.log('== 打包 ==')
await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: join(outDir, 'bundle.js'),
  loader: { '.css': 'css' },
  logLevel: 'warning',
})
await writeFile(join(outDir, 'style.css'), await readFile(join(root, 'src', 'style.css')))

const NL = String.fromCharCode(10)
const appLines = [
  "import { ChunkedEditor } from '/bundle.js'",
  '',
  '// 统计 getBoundingClientRect 调用次数',
  'let rectCalls = 0',
  'const origRect = Element.prototype.getBoundingClientRect',
  'Element.prototype.getBoundingClientRect = function (...args) {',
  '  rectCalls++',
  '  return origRect.apply(this, args)',
  '}',
  '',
  'const NL = String.fromCharCode(10)',
  'const parts = []',
  'for (let i = 0; i < 60; i++) {',
  "  parts.push('## Section ' + i, '', '正文内容。'.repeat(600), '')",
  '}',
  'const CONTENT = parts.join(NL)',
  '',
  "const scroller = document.getElementById('scroller')",
  '',
  'async function run() {',
  '  rectCalls = 0',
  '  const ed = new ChunkedEditor({ scroller, content: CONTENT, splitLevel: 2 })',
  '  await ed.mount()',
  '  await new Promise(r => setTimeout(r, 200))',
  '  const mountCalls = rectCalls',
  '',
  '  // 滚动 30 步',
  '  rectCalls = 0',
  '  const STEPS = 30',
  '  const t0 = performance.now()',
  '  for (let i = 0; i < STEPS; i++) {',
  '    scroller.scrollTop = i * 2000',
  '    await new Promise(r => requestAnimationFrame(r))',
  '    await ed.sync()',
  '  }',
  '  const t1 = performance.now()',
  '  const scrollCalls = rectCalls',
  '  ed.destroy()',
  '  return { mountCalls, scrollCalls, ms: (t1 - t0) / STEPS }',
  '}',
  '',
  'const r1 = await run()',
  'const r2 = await run()',
  '',
  'window.__RESULT__ = { first: r1, second: r2 }',
  'window.__DONE__ = true',
  '',
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
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__DONE__ === true, { timeout: 120000 })

const r = await page.evaluate(() => window.__RESULT__)

console.log('\n=== 真实浏览器(Chromium)===\n')
console.log(`首次运行:`)
console.log(`  挂载阶段 getBoundingClientRect 调用: ${r.first.mountCalls} 次`)
console.log(`  滚动 30 步调用:                     ${r.first.scrollCalls} 次`)
console.log(`  滚动耗时:                           ${r.first.ms.toFixed(2)} ms/步`)
console.log(`\n第二次运行(缓存已热):`)
console.log(`  挂载阶段调用: ${r.second.mountCalls} 次`)
console.log(`  滚动 30 步调用: ${r.second.scrollCalls} 次`)
console.log(`  滚动耗时:     ${r.second.ms.toFixed(2)} ms/步`)

if (errors.length) {
  console.log('\n错误:')
  errors.forEach((e) => console.log('  ! ' + e))
}

await browser.close()
server.close()
