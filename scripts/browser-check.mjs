/**
 * 浏览器环境验证:用 esbuild 打出真实浏览器 bundle,在 Chromium 里跑。
 *
 * 为什么要这么做:
 *   happy-dom 是 DOM 模拟,不能证明浏览器兼容性。
 *   裸模块说明符(如 '@milkdown/kit/core')浏览器无法直接解析,
 *   生产环境靠打包器处理。这里用 esbuild 模拟打包器行为,
 *   验证的是「打包后产物在真实浏览器里能否正常运行」。
 *
 * 覆盖的关键问题:Node.fromJSON 这条路径在浏览器/WebView 里是否可用。
 */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'scripts', '.browser-build')

await mkdir(outDir, { recursive: true })

// ---- 1. 打浏览器 bundle ----
console.log('== 打包(模拟生产环境 bundler)==')
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
const bundleSrc = await readFile(join(outDir, 'bundle.js'), 'utf8')
console.log(`  bundle.js ${(bundleSrc.length / 1024).toFixed(1)} KB`)

// 检查 bundle 里是否残留 Node 内置模块引用
const nodeBuiltins = [
  ...bundleSrc.matchAll(/from\s*["'](node:[a-z_]+|fs|path|os|crypto|util|events|stream|buffer)["']/g),
].map((m) => m[1])
console.log(`  Node 内置模块引用: ${nodeBuiltins.length === 0 ? '无 ✓' : nodeBuiltins.join(', ')}`)

await writeFile(join(outDir, 'style.css'), await readFile(join(root, 'src', 'style.css')))

// ---- 2. 页面脚本单独成文件,避开模板字符串转义 ----
const NL = String.fromCharCode(10)
const appJs = [
  "import { ChunkedEditor, DocCache } from '/bundle.js'",
  '',
  'window.__ENV__ = {',
  '  ua: navigator.userAgent,',
  "  hasProcess: typeof process !== 'undefined',",
  "  hasRequire: typeof require !== 'undefined',",
  "  hasBuffer: typeof Buffer !== 'undefined',",
  '}',
  '',
  'const NL = String.fromCharCode(10)',
  'const parts = []',
  'for (let i = 0; i < 40; i++) {',
  "  parts.push('## Section ' + i, '', 'Body line for section ' + i + '.', '', 'More content here.', '')",
  '}',
  'const CONTENT = parts.join(NL)',
  '',
  "const scroller = document.getElementById('scroller')",
  'const editor = new ChunkedEditor({ scroller, content: CONTENT, splitLevel: 2 })',
  'await editor.mount()',
  'await new Promise(r => requestAnimationFrame(r))',
  '',
  'const stats = editor.cacheStats',
  'const cache = new DocCache()',
  "cache.set('x', CONTENT, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'probe' }] }] })",
  "const entry = cache.get('x', CONTENT)",
  '',
  'window.__RESULT__ = {',
  '  env: window.__ENV__,',
  '  cacheEntries: stats.entries,',
  '  cacheBytes: stats.bytes,',
  '  docCacheHit: entry !== undefined,',
  "  proseMirror: scroller.querySelectorAll('.ProseMirror').length,",
  "  headings: scroller.querySelectorAll('h2').length,",
  "  paragraphs: scroller.querySelectorAll('p').length,",
  "  cvSupported: typeof CSS !== 'undefined' && CSS.supports('content-visibility', 'auto'),",
  '  cvApplied: (() => {',
  "    const slot = document.querySelector('.chunk-slot')",
  "    return !!slot && getComputedStyle(slot).contentVisibility === 'auto'",
  '  })(),',
  '  outlineLen: editor.getOutline().length,',
  '  mdLen: editor.getMarkdown().length,',
  '}',
  '',
  'const total = editor.getOutline().length',
  "const mountedInitial = scroller.querySelectorAll('.milkdown-chunk-root').length",
  'scroller.scrollTop = 6000',
  'await new Promise(r => setTimeout(r, 500))',
  'await new Promise(r => requestAnimationFrame(r))',
  "const roots = [...scroller.querySelectorAll('.milkdown-chunk-root')]",
  'window.__RESULT__.virtual = {',
  '  total,',
  '  mountedInitial,',
  '  mountedAfterScroll: roots.length,',
  '  uniqueIds: new Set(roots.map(e => e.dataset.chunkId)).size,',
  '}',
  '',
  'window.__READY__ = true',
  '',
].join(NL)
await writeFile(join(outDir, 'app.js'), appJs)

await writeFile(
  join(outDir, 'index.html'),
  [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<link rel="stylesheet" href="/style.css">',
    '<style>#scroller{height:600px;overflow-y:auto;border:1px solid #ddd}</style>',
    '</head><body>',
    '<div id="scroller"></div>',
    '<script type="module" src="/app.js"></script>',
    '</body></html>',
    '',
  ].join(NL)
)

// ---- 3. 起静态服务器 ----
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }
const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const file = join(outDir, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!existsSync(file)) {
      res.writeHead(404).end('nf')
      return
    }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  })
  s.listen(0, '127.0.0.1', () => resolve(s))
})
const { port } = server.address()

// ---- 4. 浏览器里跑 ----
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

let pass = 0
let fail = 0
const check = (c, m) => {
  if (c) {
    pass++
    console.log('  PASS ' + m)
  } else {
    fail++
    console.log('  FAIL ' + m)
  }
}

console.log('\n== 浏览器环境 ==')
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
try {
  await page.waitForFunction(() => window.__READY__ === true, { timeout: 30000 })
} catch {
  console.log('  ! 等待 __READY__ 超时')
  errors.forEach((e) => console.log('  ! ' + e))
  await browser.close()
  server.close()
  process.exit(1)
}

const r = await page.evaluate(() => window.__RESULT__)
console.log('  UA:', r.env.ua.slice(0, 70))

console.log('\n== 1. 确认是真实浏览器(无 Node API)==')
check(r.env.hasProcess === false, '无 process')
check(r.env.hasRequire === false, '无 require')
check(r.env.hasBuffer === false, '无 Buffer')

console.log('\n== 2. Node.fromJSON 路径可用 ==')
check(r.docCacheHit === true, 'doc JSON 缓存读写正常')
check(r.cacheEntries > 0, `缓存已回填 (${r.cacheEntries} 条 / ${r.cacheBytes} 字节)`)

console.log('\n== 3. 编辑器真实渲染 ==')
check(r.proseMirror > 0, `ProseMirror 已渲染 (${r.proseMirror})`)
check(r.headings > 0, `标题已渲染 (${r.headings})`)
check(r.paragraphs > 0, `段落已渲染 (${r.paragraphs})`)
check(r.mdLen > 0, `全文可导出 (${r.mdLen} 字符)`)

console.log('\n== 4. content-visibility ==')
check(r.cvSupported === true, '浏览器支持 content-visibility')
check(r.cvApplied === true, '已应用到 slot')

console.log('\n== 5. 虚拟滚动 ==')
check(r.virtual.mountedInitial > 0, `初始挂载 ${r.virtual.mountedInitial} 个`)
check(
  r.virtual.mountedAfterScroll < r.virtual.total,
  `滚动后 ${r.virtual.mountedAfterScroll} < 总数 ${r.virtual.total}`
)
check(r.virtual.uniqueIds === r.virtual.mountedAfterScroll, '无重复挂载')

console.log('\n== 6. 无未捕获错误 ==')
errors.forEach((e) => console.log('  ! ' + e))
check(errors.length === 0, `无错误 (${errors.length})`)

await browser.close()
server.close()

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
console.log(`Node 内置模块引用: ${nodeBuiltins.length === 0 ? '无 ✓' : nodeBuiltins.join(', ')}`)
process.exit(fail > 0 ? 1 : 0)
