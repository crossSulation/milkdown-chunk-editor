/**
 * 布局优化的严格对照:旧实现 vs 新实现。
 *
 * 用法:node scripts/layout-compare.mjs
 * 会分别打包 git HEAD 的旧实现与当前工作区的新实现,在同一浏览器里测量。
 *
 * 测量指标:
 *   1. getBoundingClientRect 调用次数(每次可能触发强制 reflow)
 *   2. style.top 写入次数(每次让布局失效)
 *   3. 滚动耗时
 *   4. 大量块时的布局计算耗时(体现 Fenwick vs O(n) 前缀和的差异)
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
const oldDir = join(outDir, '..', '.old-impl')

const NL = String.fromCharCode(10)

// ---- 导出旧实现 ----
// 用 git show 逐文件取,避免依赖 tar 命令的跨平台参数差异
await rm(oldDir, { recursive: true, force: true })
await mkdir(oldDir, { recursive: true })
{
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'src'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  for (const file of files) {
    const content = execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    })
    const target = join(oldDir, file)
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

await mkdir(outDir, { recursive: true })
await bundle(oldDir, join(outDir, 'old.js'))
await bundle(root, join(outDir, 'new.js'))
await writeFile(join(outDir, 'style.css'), await readFile(join(root, 'src', 'style.css')))

const appLines = [
  "const NL = String.fromCharCode(10)",
  'const parts = []',
  'for (let i = 0; i < 80; i++) parts.push("## Section " + i, "", "正文内容。".repeat(400), "")',
  'const CONTENT = parts.join(NL)',
  "const scroller = document.getElementById('scroller')",
  '',
  'let rectCalls = 0',
  'const origRect = Element.prototype.getBoundingClientRect',
  'Element.prototype.getBoundingClientRect = function (...a) { rectCalls++; return origRect.apply(this, a) }',
  '',
  'async function run(mod) {',
  '  const { ChunkedEditor } = await import(mod)',
  '  rectCalls = 0',
  '  const ed = new ChunkedEditor({ scroller, content: CONTENT, splitLevel: 2 })',
  '  await ed.mount()',
  '  await new Promise(r => requestAnimationFrame(r))',
  '  await new Promise(r => requestAnimationFrame(r))',
  '  const mountRect = rectCalls',
  '',
  '  // 滚动 40 步',
  '  rectCalls = 0',
  '  const STEPS = 40',
  '  const t0 = performance.now()',
  '  for (let i = 0; i < STEPS; i++) {',
  '    scroller.scrollTop = i * 2500',
  '    await new Promise(r => requestAnimationFrame(r))',
  '    await ed.sync()',
  '  }',
  '  const t1 = performance.now()',
  '  const scrollRect = rectCalls',
  '  const md = ed.getMarkdown()',
  '  ed.destroy()',
  '  return { mountRect, scrollRect, ms: (t1 - t0) / STEPS, mdLen: md.length }',
  '}',
  '',
  '// 各跑两遍,取第二遍(热身完成)',
  'await run("/old.js")',
  'await run("/new.js")',
  'const oldR = await run("/old.js")',
  'const newR = await run("/new.js")',
  'window.__RESULT__ = { old: oldR, new: newR }',
  'window.__DONE__ = true',
  '',
]

await writeFile(join(outDir, 'app.js'), appLines.join(NL))
await writeFile(
  join(outDir, 'index.html'),
  [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
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

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__DONE__ === true, { timeout: 180000 })

const r = await page.evaluate(() => window.__RESULT__)

console.log('\n=== 真实浏览器(Chromium),80 块文档 ===\n')
console.log('指标                    旧实现      新实现     差异')
console.log('─'.repeat(58))
console.log(
  `挂载阶段 rect 调用      ${String(r.old.mountRect).padStart(6)}      ${String(r.new.mountRect).padStart(6)}`
)
console.log(
  `滚动 40 步 rect 调用     ${String(r.old.scrollRect).padStart(6)}      ${String(r.new.scrollRect).padStart(6)}`
)
console.log(
  `滚动耗时 (ms/步)        ${r.old.ms.toFixed(2).padStart(6)}      ${r.new.ms.toFixed(2).padStart(6)}     ${(r.old.ms / r.new.ms).toFixed(2)}x`
)
console.log(
  `导出内容长度            ${String(r.old.mdLen).padStart(6)}      ${String(r.new.mdLen).padStart(6)}`
)
console.log(
  `\n内容一致: ${r.old.mdLen === r.new.mdLen ? '✓ 是' : '✗ 否!'}`
)

if (errors.length) {
  console.log('\n错误:')
  errors.forEach((e) => console.log('  ! ' + e))
}

await browser.close()
server.close()
