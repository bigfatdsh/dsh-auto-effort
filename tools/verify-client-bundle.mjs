/**
 * 客户端打包自检：确认浏览器半边"能被宿主的组合器收下"。
 *
 * 宿主启动时会把 profile 里每个声明了 `dsh.client` 的包的 `exports["./client"]`
 * 读成字节发给浏览器。任何一个环节对不上，症状都是**整个客户端组合失败、应用打不开**
 * （本机日志里出现过 `MissingClientBundleError`），而且宿主侧看起来一切正常。
 * 所以这里把那套声明逐条对一遍，再真的按 `__ModuleLoader__` 契约执行一次。
 *
 * 用法：node tools/verify-client-bundle.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 1) 声明：平台、入口、注入依赖。
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 必须是 web')
assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client.inject 必须声明')
const clientExport = pkg.exports?.['./client']
assert.equal(typeof clientExport, 'string', 'exports["./client"] 必须指向 bundle 文件')
const clientPath = join(root, clientExport)
assert.equal(existsSync(clientPath), true, `client bundle 文件不存在：${clientExport}`)

// 2) bundle 文件里的模块 id：与可用的官方插件（dsh-session-cost 等）同一约定——包名。
const source = readFileSync(clientPath, 'utf8')
assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
const idMatch = source.match(/\n\s*id: '([^']+)'/)
assert.ok(idMatch !== null, 'bundle 必须注册一个字符串 id')
assert.equal(idMatch[1], pkg.name, 'bundle 注册的 id 必须等于包名')

// 3) 真按契约执行一次：只允许 require('react')。
let registration
globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } }
globalThis.document = {
  visibilityState: 'visible',
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { append: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}
new Function('window', 'document', source)(globalThis.window, globalThis.document)
assert.equal(registration?.id, pkg.name)

/** 最小 React 替身：bundle 在模块作用域里只用到 createElement；hooks 由组件渲染时取。 */
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (value) => [value, () => {}],
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useEffect: () => {},
}
const moduleExports = registration.factory((specifier) => {
  assert.equal(specifier, 'react', `浏览器里只有 react 是种子模块，出现了 require("${specifier}")`)
  return react
})
assert.deepEqual(moduleExports.inject, ['slots'])
assert.equal(typeof moduleExports.apply, 'function')

// 4) apply 要真的把胶囊注册进输入栏右侧插槽，并且注册字典与样式。
const styleIds = []
const slots = []
globalThis.document.createElement = () => ({ id: '', textContent: '' })
globalThis.document.head.append = (node) => styleIds.push(node.id)
moduleExports.apply({
  effect: (fn) => {
    fn()
    return () => {}
  },
  slots: {
    inject: (_target, register) => register(),
    register: (options, component) => slots.push({ options, component }),
  },
})
assert.equal(slots.length, 1)
assert.equal(slots[0].options.name, 'conversation.input.right')
assert.equal(typeof slots[0].component, 'function')
assert.equal(styleIds.length, 1, '必须注入一份样式')

// 5) 纯度闸门：bundle 里只允许 require 启动期种子模块。请求自己包的子路径（例如
//    `dsh-auto-effort/efforts`）会让整个客户端组合失败——应用直接打不开（真实踩过），
//    而宿主侧完全看不出来。所以在这里静态挡一道。
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const requires = [...code.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
assert.deepEqual([...new Set(requires)], ['react'], `bundle 只能 require react，实际：${requires.join(', ')}`)

// 6) 同理禁止 import/相对导入：客户端只服务包根目录下的单文件 bundle
//    （`client.<name>.js`），`./other.js` 会 404 —— 症状和上面一样，是整个页面打不开。
assert.doesNotMatch(code, /^\s*import\s/m, 'bundle 不能有 import 语句')
assert.doesNotMatch(code, /from\s+'\.\//, 'bundle 不能相对导入兄弟文件')

// 7) 菜单标记必须真的内联在这个文件里（拆出去就只能靠相对导入，见上一条）。
for (const fn of ['findAutoOption', 'readSelected', 'syncEffortMenu']) {
  assert.match(code, new RegExp(`function ${fn}\\(`), `bundle 缺少内联函数 ${fn}`)
}

console.log('client bundle OK:', pkg.name, '→', clientExport)
