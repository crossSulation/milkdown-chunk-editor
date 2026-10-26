/**
 * 浏览器端 recycle 收益验证:真实 Chromium 中对比 recycle 开/关的滚动耗时。
 *
 * 模拟真实滚动:连续改变 scrollTop,每次等 sync 完成,记录总耗时。
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
  'const NL = String.fromCharCode(10)',
  'const parts = []',
  'for (let i = 0; i < 60; i++) {',
  "  parts.push('## Section ' + i, '', '正文内容。'.repeat(800), '')",
  '}',
  'const CONTENT = parts.join(NL)',
  '',
  "const scroller = document.getElementById('scroller')",
  '',
  'async function run(recycle) {',
  '  const ed = new ChunkedEditor({',
  '    scroller,',
  '    content: CONTENT,',
  '    splitLevel: 2,',
  '    recycle,',
  '    poolSize: 3,',
  '  })',
  '  await ed.mount()',
  '',
  '  // 预热:先滚一遍,让缓存填上',
  '  for (let i = 0; i < 5; i++) {',
  '    scroller.scrollTop = i * 2000',
  '    await new Promise(r => setTimeout(r, 80))',
  '    await ed.sync()',
  '  }',
  '',
  '  const STEPS = 30',
  '  const t0 = performance.now()',
  '  for (let i = 0; i < STEPS; i++) {',
  '    scroller.scrollTop = i * 2000',
  '    await new Promise(r => requestAnimationFrame(r))',
  '    await ed.sync()',
  '  }',
  '  const t1 = performance.now()',
  '  const md = ed.getMarkdown()',
  '  ed.destroy()',
  '  return { ms: (t1 - t0) / STEPS, mdLen: md.length }',
  '}',
  '',
  'await run(false)',
  'await run(true)',
  '',
  'const withoutRecycle = await run(false)',
  'const withRecycle = await run(true)',
  '',
  'window.__RESULT__ = { withoutRecycle, withRecycle }',
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
await page.waitForFunction(() => window.__DONE__ === true, { timeout: 180000 })

const r = await page.evaluate(() => window.__RESULT__)

console.log('\n=== 真实浏览器(Chromium)滚动 30 步 ===\n')
console.log(`recycle: false → ${r.withoutRecycle.ms.toFixed(2)} ms/步`)
console.log(`recycle: true  → ${r.withRecycle.ms.toFixed(2)} ms/步`)
console.log(
  `\n提速: ${(r.withoutRecycle.ms / r.withRecycle.ms).toFixed(2)}x,省 ${(r.withoutRecycle.ms - r.withRecycle.ms).toFixed(2)} ms/步`
)
console.log(`\n内容长度校验: ${r.withoutRecycle.mdLen} vs ${r.withRecycle.mdLen}`)
console.log(
  r.withoutRecycle.mdLen === r.withRecycle.mdLen ? '✓ 两者一致' : '✗ 不一致!'
)

if (errors.length) {
  console.log('\n错误:')
  errors.forEach((e) => console.log('  ! ' + e))
}

await browser.close()
server.close()
