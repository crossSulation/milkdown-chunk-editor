/**
 * 浏览器端复用收益验证:在真实 Chromium 里分解挂载/销毁成本。
 *
 *   A. 挂载 + 销毁 —— 当前实现(滚出滚入时走的路)
 *   B. 仅挂载      —— 测出创建成本
 *   销毁 = A - B
 *
 * 目的:用真实浏览器数据判断「实例复用」值不值得做。
 * Node 环境的比例与浏览器不同,不能拿 Node 数字下结论。
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
  'for (let i = 0; i < 10; i++) {',
  "  parts.push('## Section ' + i, '', '正文内容。'.repeat(3000), '')",
  '}',
  'const CONTENT = parts.join(NL)',
  '',
  "const scroller = document.getElementById('scroller')",
  'const ROUNDS = 25',
  '',
  'async function measureRebuild() {',
  '  const t0 = performance.now()',
  '  for (let r = 0; r < ROUNDS; r++) {',
  '    const el = document.createElement("div")',
  '    const ed = new ChunkedEditor({ scroller: el, content: CONTENT, splitLevel: 2 })',
  '    await ed.mount()',
  '    ed.destroy()',
  '  }',
  '  const t1 = performance.now()',
  '  return (t1 - t0) / ROUNDS',
  '}',
  '',
  'async function measureMountOnly() {',
  '  const t0 = performance.now()',
  '  const alive = []',
  '  for (let r = 0; r < ROUNDS; r++) {',
  '    const el = document.createElement("div")',
  '    const ed = new ChunkedEditor({ scroller: el, content: CONTENT, splitLevel: 2 })',
  '    await ed.mount()',
  '    alive.push([el, ed])',
  '  }',
  '  const t1 = performance.now()',
  '  for (const [, ed] of alive) ed.destroy()',
  '  return (t1 - t0) / ROUNDS',
  '}',
  '',
  'await measureRebuild()',
  'await measureMountOnly()',
  '',
  'const rebuild = await measureRebuild()',
  'const mountOnly = await measureMountOnly()',
  '',
  'window.__RESULT__ = { rebuild, mountOnly, rounds: ROUNDS }',
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
const destroyOnly = r.rebuild - r.mountOnly

console.log('\n=== 真实浏览器(Chromium)===\n')
console.log('文档:10 块,每块约 6000 字符')
console.log(`挂载 + 销毁(当前):  ${r.rebuild.toFixed(2)} ms/轮`)
console.log(`仅挂载:             ${r.mountOnly.toFixed(2)} ms/轮`)
console.log(`仅销毁:             ${destroyOnly.toFixed(2)} ms/轮`)
console.log(
  `\n=> 创建占 ${((r.mountOnly / r.rebuild) * 100).toFixed(0)}%,销毁占 ${((destroyOnly / r.rebuild) * 100).toFixed(0)}%`
)

if (errors.length) {
  console.log('\n错误:')
  errors.forEach((e) => console.log('  ! ' + e))
}

await browser.close()
server.close()
