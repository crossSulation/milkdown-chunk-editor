import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  // 仅 ESM:@milkdown/kit 的 exports 只声明了 import 条件,没有 require,
  // 产出 CJS 反而会在 require 时报 ERR_PACKAGE_PATH_NOT_EXPORTED
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // @milkdown/kit 只提供 import 条件,不能打进产物
  // @milkdown/prose/* 必须保持 external —— ProseMirror 的 Plugin/PluginKey
  // 是有状态的单例,若在包内内联一份,会与宿主应用使用的不是同一套实例,
  // 导致 plugin key 冲突、状态无法共享
  external: [
    '@milkdown/kit',
    '@milkdown/kit/*',
    '@milkdown/prose',
    '@milkdown/prose/*',
  ],
  treeshake: true,
  target: 'es2022',
  // tsup 不会搬运非入口引用的静态资源,这里显式拷贝样式到 dist
  onSuccess: async () => {
    const { copyFile, mkdir } = await import('node:fs/promises')
    await mkdir('dist', { recursive: true })
    await copyFile('src/style.css', 'dist/style.css')
  },
})