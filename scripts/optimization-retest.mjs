/**
 * 用正确的测量方法重测各项优化的独立贡献。
 *
 * 测量方法的三条铁律(前两轮栽在这上面):
 *   1. 不 await requestAnimationFrame —— rAF 按 60fps 节流,等帧测出的是帧间隔
 *   2. 每种配置用独立页面测 —— 避免前一个配置的 JIT/GC 影响后一个
 *   3. 交替顺序跑多轮取中位数 —— 消除顺序效应
 *
 * 基线怎么来:
 *   仓库第一个提交 b1b0f21 已经包含全部三项优化,所以它不是真基线。
 *   这里改为从当前源码【派生】变体:把对应的优化代码去掉,其余完全相同。
 *   这样对比才公平 —— 唯一变量就是那项优化本身。
 *
 * 用法:node scripts/optimization-retest.mjs
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
const variantsRoot = join(root, 'scripts', '.variants')

await mkdir(outDir, { recursive: true })

const SRC_FILES = [
  'index.ts',
  'chunked-editor.ts',
  'doc-cache.ts',
  'editor-pool.ts',
  'mount-chunk.ts',
  'split.ts',
  'virtual-layout.ts',
  'style.css',
]

/** 复制一份源码作为变体的工作副本 */
async function makeVariant(name) {
  const dir = join(variantsRoot, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const f of SRC_FILES) {
    await cp(join(root, 'src', f), join(dir, f))
  }
  return dir
}

async function patchFile(dir, file, transform) {
  const p = join(dir, file)
  const src = await readFile(p, 'utf8')
  const next = transform(src)
  if (next === src) {
    console.error(`!! ${file} 补丁未生效(${name})`)
    process.exit(1)
  }
  await writeFile(p, next)
}

// ---- 变体 1:无 dirty 标记 ----
const noDirtyDir = await makeVariant('no-dirty')
await patchFile(noDirtyDir, 'mount-chunk.ts', (src) =>
  src.replace(
    /    \/\/ 内容没被改过就不必序列化[\s\S]*?if \(!dirty\) return;\n/,
    '    // [变体] 故意去掉 dirty 检查:每次卸载都无条件 stringify\n'
  )
)

// ---- 变体 2:无 doc JSON 缓存 ----
// 缓存的开关已是 disableCache,直接用参数即可,无需派生。

// ---- 变体 3:三项全无 ----
const noOptDir = await makeVariant('no-opt')
await patchFile(noOptDir, 'mount-chunk.ts', (src) =>
  src.replace(
    /    \/\/ 内容没被改过就不必序列化[\s\S]*?if \(!dirty\) return;\n/,
    '    // [变体] 故意去掉 dirty 检查\n'
  )
)

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
await bundle(join(noOptDir, 'index.ts'), join(outDir, 'noopt.js'))
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
  'const OPTS = JSON.parse(new URLSearchParams(location.search).get("opts") || "{}")',
  'async function run() {',
  "  const { ChunkedEditor } = await import(MOD)",
  '  const ed = new ChunkedEditor({ scroller, content: CONTENT, splitLevel: 2, overscan: 1, ...OPTS })',
  '  await ed.mount()',
  '  await new Promise(r => setTimeout(r, 300))',
  '  // 预热:走一遍全文,让缓存填满',
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

const configs = [
  // 隔离测量:固定『仅缓存』配置(关 recycle),只变 dirty —— 其他变量相同
  { label: '仅缓存-无dirty', mod: '/nodirty.js', opts: { recycle: false } },
  { label: '三项全无(派生基线)', mod: '/noopt.js', opts: { disableCache: true, recycle: false } },
  { label: '仅 dirty 标记', mod: '/nodirty.js', opts: { disableCache: true, recycle: false } },
  { label: '仅 doc 缓存', mod: '/current.js', opts: { recycle: false } },
  { label: '仅实例复用', mod: '/current.js', opts: { disableCache: true } },
  { label: '三项全开', mod: '/current.js', opts: {} },
]

const browser = await chromium.launch()
const samples = {}
for (const c of configs) samples[c.label] = []

for (let round = 0; round < 5; round++) {
  const order = round % 2 === 0 ? configs : [...configs].reverse()
  for (const c of order) {
    const page = await browser.newPage()
    await page.goto(
      `http://127.0.0.1:${port}/?mod=${encodeURIComponent(c.mod)}&opts=${encodeURIComponent(JSON.stringify(c.opts))}`,
      { waitUntil: 'networkidle' }
    )
    await page.waitForFunction(() => window.__DONE__ === true, { timeout: 120000 })
    const r = await page.evaluate(() => window.__RESULT__)
    samples[c.label].push(r.ms)
    await page.close()
  }
}

const med = (label) => {
  const s = [...samples[label]].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

console.log('\n=== 各优化独立贡献(40 块文档,60 步滚动)===')
console.log('独立页面 + 交替顺序 + 5 轮取中位数\n')
console.log('配置'.padEnd(24) + '中位数'.padStart(10) + '最小'.padStart(10) + '相对基线'.padStart(11))
console.log('─'.repeat(58))
const baseMed = med(configs[0].label)
for (const c of configs) {
  const s = [...samples[c.label]].sort((a, b) => a - b)
  const m = med(c.label)
  const d = ((baseMed - m) / baseMed) * 100
  const mark = c === configs[0] ? '(基线)' : `${d >= 0 ? '-' : '+'}${Math.abs(d).toFixed(0)}%`
  console.log(c.label.padEnd(24) + m.toFixed(3).padStart(10) + s[0].toFixed(3).padStart(10) + mark.padStart(11))
}

console.log('\n--- 单项收益 ---')
const allOff = med('三项全无(派生基线)')
console.log(`dirty 标记:      ${allOff.toFixed(3)}ms → ${med('仅 dirty 标记').toFixed(3)}ms   ${(allOff / med('仅 dirty 标记')).toFixed(2)}x`)
console.log(`doc JSON 缓存:   ${allOff.toFixed(3)}ms → ${med('仅 doc 缓存').toFixed(3)}ms   ${(allOff / med('仅 doc 缓存')).toFixed(2)}x`)
console.log(`实例复用:        ${allOff.toFixed(3)}ms → ${med('仅实例复用').toFixed(3)}ms   ${(allOff / med('仅实例复用')).toFixed(2)}x`)
console.log(`三项全开:        ${allOff.toFixed(3)}ms → ${med('三项全开').toFixed(3)}ms   ${(allOff / med('三项全开')).toFixed(2)}x`)

await browser.close()
server.close()
