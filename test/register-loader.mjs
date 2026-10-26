/**
 * 注册测试用 ESM loader。
 * 用法: node --experimental-strip-types --import ./test/register-loader.mjs test/xxx.ts
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./loader.mjs', pathToFileURL(import.meta.filename))
