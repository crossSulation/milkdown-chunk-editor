/**
 * 测试用 ESM loader:为无扩展名的相对导入补上 .ts。
 *
 * 源码里保持 './virtual-layout' 这种写法(打包器友好),
 * 但 Node 原生 ESM 解析器要求显式扩展名。
 * 这个 loader 只在测试时生效,不影响产物。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对导入
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentPath = context.parentURL
      ? dirname(fileURLToPath(context.parentURL))
      : process.cwd()
    const base = resolvePath(parentPath, specifier)

    const candidates = [base, `${base}.ts`, `${base}.tsx`, resolvePath(base, 'index.ts')]
    for (const c of candidates) {
      if (existsSync(c) && !c.endsWith('/')) {
        try {
          const stat = (await import('node:fs')).statSync(c)
          if (stat.isFile()) {
            return { url: pathToFileURL(c).href, shortCircuit: true }
          }
        } catch {
          // 忽略,继续下一个候选
        }
      }
    }
  }
  return nextResolve(specifier, context)
}
