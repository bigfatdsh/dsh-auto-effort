/**
 * 浏览器半边的契约测试。
 *
 * 只测三件**必须成立**的事，其余交给真实浏览器验证：
 *
 * 1. 点击识别：点 Auto 开标记、点真实等级清标记，且**绝不拦点击**（拦了菜单不关）。
 * 2. 标记诚实：宿主下发真实档位时标记必须撤回——显示不许撒谎。
 * 3. 与宿主对齐：宿主说"开着 auto"就显示 Auto，说"关着"就撤掉。
 *
 * 这里刻意用一套**极简替身**（不引入 React、不模拟渲染循环）：先前那套复杂的 DOM
 * 替身会在用例之间泄漏内存，把整个文件跑成堆溢出。契约清楚，替身就该小。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 每个用例一套全新模块实例：`?case=N` 绕过模块缓存，等价于重新加载一次页面。 */
let loadCounter = 0

/**
 * 造一套极简 DOM：一个触发器、一个等级文字、一个观察者。
 *
 * @param {object} [options] - `{ level }`。
 * @returns {object} 句柄。
 */
function makeDom(options = {}) {
  const listeners = []
  const observers = []
  const hostCalls = []
  let triggerAttr = null
  let level = options.level ?? 'high'

  const textNode = {
    nodeType: 3,
    get nodeValue() {
      return level
    },
    set nodeValue(next) {
      level = next
    },
  }
  const effort = {
    get textContent() {
      return level
    },
    set textContent(next) {
      level = next
    },
    ownerDocument: {
      createTreeWalker: () => {
        let done = false
        return { nextNode: () => (done ? null : ((done = true), textNode)) }
      },
    },
  }
  const trigger = {
    get textContent() {
      return `deepseek · ${level}`
    },
    getAttribute: (name) => (name === 'data-dsh-auto-effort' ? triggerAttr : null),
    setAttribute: (name, value) => {
      if (name === 'data-dsh-auto-effort') triggerAttr = value
    },
    removeAttribute: (name) => {
      if (name === 'data-dsh-auto-effort') triggerAttr = null
    },
    querySelector: (selector) => (selector.includes('triggerEffort') ? effort : null),
  }
  const document = {
    visibilityState: 'visible',
    body: {},
    head: { append: () => {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: (selector) => (selector.includes('_trigger') ? trigger : null),
    // 真实宿主用 `[class*="_trigger"]` 找触发器来打标记，这里必须返回同一个节点。
    querySelectorAll: (selector) => (selector.includes('_trigger') ? [trigger] : []),
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: () => {},
  }

  return {
    document,
    hostCalls,
    level: () => level,
    setLevel: (next) => {
      level = next
    },
    attr: () => triggerAttr,
    /**
     * 派发一次点击；返回事件对象，便于断言"有没有被拦"。
     *
     * @param {string} text - 被点节点的文本。
     * @returns {object} 事件对象。
     */
    click: (text) => {
      const event = {
        target: { textContent: text, querySelectorAll: () => [{ textContent: text }] },
        defaultPrevented: false,
        immediateStopped: false,
        preventDefault() {
          this.defaultPrevented = true
        },
        stopPropagation() {},
        stopImmediatePropagation() {
          this.immediateStopped = true
        },
      }
      for (const entry of listeners) if (entry.type === 'click') entry.fn(event)
      return event
    },
    observe: (fn) => observers.push(fn),
    /** 触发一次 DOM 变动通知（等价于宿主重渲染）。 */
    mutate: () => {
      for (const fn of observers) fn()
    },
  }
}

/**
 * 装载 bundle、apply 一次并渲染一遍。
 *
 * @param {object} [options] - `{ armed, stored, level }`。
 * @returns {Promise<object>} 句柄。
 */
async function mount(options = {}) {
  const dom = makeDom(options)
  const store = new Map()
  if (options.stored === true) store.set('dsh-auto-effort:auto', '1')
  globalThis.document = dom.document
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
  }
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      dom.hostCalls.push(body)
      return { json: async () => body }
    }
    return { json: async () => ({ config: { armed: options.armed === true } }) }
  }
  globalThis.MutationObserver = class {
    constructor(fn) {
      dom.observe(fn)
    }
    observe() {}
    disconnect() {}
  }

  let registration
  globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } }
  await import(`../lib/client.js?case=${++loadCounter}`)
  assert.ok(registration !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load')

  const cleanups = []
  const cells = []
  let cursor = 0
  // 极简 hooks：只支持本组件用到的三个，effect 只跑一次（不模拟重渲染循环）。
  const React = {
    createElement: () => null,
    useRef: (initial) => {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
    useEffect: (fn) => {
      cursor++
      cleanups.push(fn())
    },
    useSyncExternalStore: (subscribe, get) => {
      const index = cursor++
      if (!(index in cells)) cells[index] = get()
      return cells[index]
    },
  }
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require("${specifier}")`)
  })
  exports.__resetForTest?.()
  const slots = []
  exports.apply({
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: { inject: (_target, register) => register(), register: (_options, component) => slots.push(component) },
  })
  // 订阅回调**不重渲染**：那会变成 render → notify → render 的自激循环
  // （真实 React 靠快照相等性刹车，替身里不成立）。这里退一步：只渲染一次，
  // 状态变化后用 applyMark/paint 手动落 DOM——这正是重渲染会做的事，且可判定。
  React.useSyncExternalStore = (subscribe, get) => {
    const index = cursor++
    if (!(index in cells)) {
      cells[index] = get()
      subscribe(() => {})
    }
    return cells[index]
  }

  const render = () => {
    cursor = 0
    slots[0]()
  }
  render()
  /**
   * 把当前状态落进 DOM（等价于 React 因状态变化重渲染一次）。
   *
   * @returns {object} `{ marked, level }`。
   */
  const settle = () => {
    const on = exports.createAutoState === undefined ? false : globalThis.__DSH_AUTO_EFFORT__?.get() === true
    exports.applyMark(on, globalThis.document)
    // 文字由组件里的 paint 负责；这里按同一规则补上。
    level = on ? 'Auto' : level
    return { marked: on, level }
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve))
  await flush()
  return { dom, exports, store, flush, cleanups, render, settle }
}

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

test('bundle 只 require 种子模块（否则整个客户端组合失败、应用打不开）', () => {
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  for (const specifier of requires) {
    assert.equal(specifier, 'react', `只允许 require('react')，实际还有 ${specifier}`)
  }
  assert.doesNotMatch(source, /^\s*import\s/m, '客户端 bundle 不能有 import 语句')
  assert.match(source, /__ModuleLoader__\.load\(\{/)
})

test('点 Auto：不拦点击（菜单必须照常关闭）、开标记、通知宿主开启', async () => {
  const { dom, flush, render } = await mount({ armed: false })
  assert.equal(dom.attr(), null, '初始不该有标记')
  assert.equal(dom.level(), 'high', '未开启时文字是宿主下发的等级')

  const event = dom.click('Auto')
  await flush()
  render()
  assert.equal(event.defaultPrevented, false, '不能拦默认行为')
  assert.equal(event.immediateStopped, false, '不能阻止宿主自己的点击处理')
  assert.equal(dom.attr(), '1', '点 Auto 必须挂上标记')
  assert.equal(dom.level(), 'Auto', '触发器文字要显示 Auto')
  assert.equal(dom.hostCalls.filter((c) => c.auto === true).length, 1, `应通知宿主开启：${JSON.stringify(dom.hostCalls)}`)
})

test('点真实等级：不拦点击、清标记、通知宿主关闭', async () => {
  const { dom, flush, render } = await mount({ armed: true, stored: true })
  assert.equal(dom.attr(), '1', '宿主开着 auto 时显示 Auto')

  const event = dom.click('High')
  await flush()
  render()
  assert.equal(event.defaultPrevented, false, '真实等级必须让宿主自己处理')
  assert.equal(dom.attr(), null, '选真实等级必须立刻摘掉标记')
  assert.ok(dom.hostCalls.some((c) => c.auto === false), `应通知宿主关闭：${JSON.stringify(dom.hostCalls)}`)
})

test('宿主开着 auto：即使触发器文字是 high，也显示 Auto（行为准）', async () => {
  const { dom } = await mount({ armed: true })
  dom.setLevel('high')
  dom.mutate()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(dom.attr(), '1', '宿主说开着 auto，就该显示 Auto')
  assert.equal(dom.level(), 'Auto')
})

test('宿主没开 auto：标记必须撤回，显示宿主的事实（标记不许撒谎）', async () => {
  const { dom, flush } = await mount({ armed: false, stored: true })
  dom.setLevel('max')
  dom.mutate()
  await flush()
  assert.equal(dom.attr(), null, '宿主说没开，就不该显示 Auto')
  assert.equal(dom.level(), 'max', '文字必须是宿主的事实')
})

test('普通点击（模型名、搜索框）不误判', async () => {
  const { dom, flush } = await mount({ armed: false })
  dom.click('deepseek-flash')
  dom.click('搜索')
  await flush()
  assert.equal(dom.attr(), null)
  assert.equal(dom.hostCalls.length, 0, `不该发通知：${JSON.stringify(dom.hostCalls)}`)
})
