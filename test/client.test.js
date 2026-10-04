/**
 * 浏览器半边的契约测试：优化图标 + 开关面板。
 *
 * 只测**必须成立**的事，渲染细节交给真实浏览器验证：
 *
 * 1. bundle 形态：只 require 种子模块、不能 import、必须按约定注册。
 * 2. 通用开关协议：读登记表、读状态、写状态，任何一步失败都不抛错。
 * 3. 面板行为：点图标开、再点关、Esc 关。
 *
 * 用**极简替身**（不模拟 React 渲染循环）：先前那套复杂替身会在用例之间泄漏内存，
 * 把整个文件跑成堆溢出。契约清楚，替身就该小。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let loadCounter = 0

/**
 * 装载 bundle 并取出 exports。
 *
 * @param {object} [options] - `{ fetch }` 替身。
 * @returns {Promise<object>} `{ exports, host, document }`。
 */
async function load(options = {}) {
  const listeners = []
  const host = []
  globalThis.document = {
    documentElement: { lang: 'zh-CN' },
    head: { append: () => {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: () => {},
  }
  globalThis.fetch = async (url, init) => {
    host.push({ url, init })
    if (typeof options.fetch === 'function') return options.fetch(url, init)
    return {
      ok: true,
      json: async () => (init?.method === 'POST' ? { enabled: JSON.parse(init.body).enabled } : { enabled: false }),
    }
  }
  let registration
  globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } }
  await import(`../lib/client.js?case=${++loadCounter}`)
  assert.ok(registration !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-auto-effort', '注册 id 必须是包名')
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return options.react ?? {}
    throw new Error(`unexpected require("${specifier}")`)
  })
  return { exports, host, listeners }
}

test('bundle 形态：只 require 种子模块、无 import、按约定注册', () => {
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  for (const specifier of requires) assert.equal(specifier, 'react', `只允许 require('react')，实际还有 ${specifier}`)
  assert.doesNotMatch(code, /^\s*import\s/m, '客户端 bundle 不能有 import 语句')
  assert.match(code, /__ModuleLoader__\.load\(\{/)
  assert.match(code, /'conversation\.input\.right'/, '必须注册到输入栏右侧插槽')
  assert.doesNotMatch(code, /data-dsh-auto-effort/, '不再动内置选择器的 DOM')
})

test('apply：注入样式一次，并注册到输入栏右侧插槽', async () => {
  const { exports } = await load()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  const registered = []
  const styles = []
  globalThis.document.head.append = (node) => styles.push(node)
  let injected = 0
  exports.apply({
    slots: {
      inject: (name, fn) => {
        injected += 1
        assert.equal(name, 'conversation.input.right')
        fn()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  })
  assert.equal(injected, 1)
  assert.equal(registered.length, 1, '应注册一个组件')
  assert.equal(registered[0].options.id, 'auto-effort-optimizer')
  assert.equal(styles.length, 1, '应注入一份样式')
  assert.equal(styles[0].id, 'dsh-auto-effort-style')
  assert.match(styles[0].textContent, /\[data-dsh-opt-icon\]/)
})

test('通用协议：读登记表 → 读状态 → 写状态', async () => {
  const { exports } = await load({
    fetch: async (url, init) => {
      if (String(url).includes('switches=1')) {
        return {
          ok: true,
          json: async () => ({
            switches: [
              { id: 'auto', label: { zh: '自动化推理等级' }, hint: { zh: 'x' }, endpoint: '/dsh-auto-effort', field: 'enabled' },
              { id: 'concise', label: { zh: '精简化输出' }, hint: { zh: 'y' }, endpoint: '/dsh-concise-output', field: 'enabled', optional: true },
            ],
          }),
        }
      }
      if (String(url).startsWith('/dsh-concise-output')) {
        // 模拟"没装那个插件"：请求失败
        throw new Error('not installed')
      }
      return { ok: true, json: async () => (init?.method === 'POST' ? { enabled: JSON.parse(init.body).enabled } : { enabled: true }) }
    },
  })
  const registry = await exports.readRegistry()
  assert.equal(registry.length, 2)
  assert.equal(await exports.readSwitch('/dsh-auto-effort', 'enabled'), true)
  assert.equal(await exports.readSwitch('/dsh-concise-output', 'enabled'), undefined, '读不到要给 undefined，调用方据此隐藏')
  assert.equal(await exports.writeSwitch('/dsh-auto-effort', 'enabled', false), false)
})

test('通用协议：端点 404 或返回垃圾时返回 undefined，不抛错', async () => {
  const { exports } = await load({
    fetch: async (url, init) => {
      if (String(url).includes('switches=1')) return { ok: true, json: async () => ({ switches: 'nope' }) }
      if (init?.method === 'POST') return { ok: false, status: 404, json: async () => ({ error: 'x' }) }
      return { ok: false, status: 404, json: async () => ({}) }
    },
  })
  assert.deepEqual(await exports.readRegistry(), [], '登记表形状不对要回退成空表')
  assert.equal(await exports.readSwitch('/nope', 'enabled'), undefined, '404 要给 undefined，不能猜')
  assert.equal(await exports.writeSwitch('/nope', 'enabled', true), undefined, '写失败要给 undefined')

  // 返回垃圾 JSON（没有布尔字段）同样要给 undefined
  const junk = await load({ fetch: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) })
  assert.equal(await junk.exports.readSwitch('/x', 'enabled'), undefined)
  assert.equal(await junk.exports.writeSwitch('/x', 'enabled', true), undefined, '写回垃圾不能被当成成功')
})

test('面板：点图标开，再点关', async () => {
  // 带状态的小运行时：闭包里的 React 必须是它，组件里的 hooks 才会真的生效。
  const cells = []
  let cursor = 0
  let render
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: (initial) => {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
    useEffect: () => {
      cursor++
    },
    useCallback: (fn) => fn,
    useState: (initial) => {
      const index = cursor++
      if (!(index in cells)) cells[index] = initial
      const set = (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next
        render()
      }
      return [cells[index], set]
    },
  }

  const { exports } = await load({ react })
  const registry = []
  exports.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => {
        registry.push({ options, component })
        return () => {}
      },
    },
  })
  assert.equal(registry.length, 1)
  const component = registry[0].component

  let tree
  render = () => {
    cursor = 0
    tree = component({})
  }
  render()

  const icon = tree.children[0]
  assert.equal(icon.props['data-dsh-opt-icon'], '', '图标按钮要在')
  assert.equal(icon.props['aria-expanded'], 'false', '初始是关闭的')
  assert.equal(tree.children[1], null, '初始不渲染面板')

  icon.props.onClick()
  assert.equal(tree.children[0].props['aria-expanded'], 'true', '点一下要打开')
  assert.equal(tree.children[1].props['data-dsh-opt-panel'], '', '点一下要渲染面板')

  tree.children[0].props.onClick()
  assert.equal(tree.children[0].props['aria-expanded'], 'false', '再点一下要关闭')
  assert.equal(tree.children[1], null, '再点一下要收起面板')
})
