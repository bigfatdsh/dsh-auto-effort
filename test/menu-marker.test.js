/**
 * dsh-auto-effort —— 推理等级菜单标记的单元测试。
 *
 * 这一组针对的是"外面显示 Auto、打开列表却勾在 High 上"这类显示不一致。它只能在
 * 真实形状的菜单节点上验证，所以这里照抄内置选择器的结构：
 * `button[role=menuitemradio][aria-checked] > span.optionCopy > span.modelName`，
 * 选中态同时体现在 `aria-checked` 与一个带哈希的类名上。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
let counter = 0

/**
 * 从**真实 bundle** 里取出菜单标记函数来测。
 *
 * 不拆成独立模块是有原因的：客户端模块系统只服务包根目录下的单文件 bundle，相对导入的
 * 兄弟文件取不到会让整个客户端组合失败（应用打不开）。所以实现在 `lib/client.js` 里，
 * 这里通过 `window.__ModuleLoader__` 的注册拿到同一份代码。
 *
 * @returns {Promise<{findAutoOption: Function, readSelected: Function, syncEffortMenu: Function}>} 被测函数。
 */
async function loadMenuHelpers() {
  let registration
  globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { append: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  await import(`../lib/client.js?menu=${++counter}`)
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') {
      return { createElement: () => null, useRef: () => ({ current: null }), useEffect: () => {}, useSyncExternalStore: () => false }
    }
    throw new Error(`unexpected require("${specifier}")`)
  })
  return exports
}

const { findAutoOption, readSelected, syncEffortMenu } = await loadMenuHelpers()

test('菜单标记的实现内联在 client.js 里，bundle 不含相对导入', () => {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /^import\s/m, 'bundle 不能有 import 语句')
  assert.doesNotMatch(source, /from '\.\//, 'bundle 不能相对导入兄弟文件')
})

/**
 * 造一个菜单项。
 *
 * @param {string} label - 等级显示名。
 * @param {boolean} selected - 初始是否选中。
 * @returns {object} 菜单项。
 */
function menuItem(label, selected = false) {
  const base = 'ModelSelect_module_option__abc'
  const marker = 'ModelSelect_module_selected__xyz'
  let className = selected ? `${base} ${marker}` : base
  let checked = selected ? 'true' : 'false'
  const inner = { textContent: label }
  return {
    get textContent() {
      return label
    },
    get className() {
      return className
    },
    set className(value) {
      className = value
    },
    getAttribute: (name) => (name === 'aria-checked' ? checked : null),
    setAttribute: (name, value) => {
      if (name === 'aria-checked') checked = value
    },
    querySelectorAll: () => [inner],
    get state() {
      return { className, checked }
    },
  }
}

/**
 * @param {object[]} items - 菜单项。
 * @returns {object} 假 document。
 */
function menuDoc(items) {
  return { querySelectorAll: (selector) => (selector === '[role="menuitemradio"]' ? items : []) }
}

test('findAutoOption：按文本精确命中 Auto，不误伤别的项', () => {
  const off = menuItem('Off')
  const high = menuItem('High', true)
  const auto = menuItem('Auto')
  assert.equal(findAutoOption([off, high, auto], 'Auto'), auto)
  assert.equal(findAutoOption([off, high], 'Auto'), undefined)
  assert.equal(findAutoOption([], 'Auto'), undefined)
  assert.equal(findAutoOption(undefined, 'Auto'), undefined)
})

test('readSelected：同时读出选中项与承载选中态的类名', () => {
  const high = menuItem('High', true)
  const auto = menuItem('Auto')
  const { node, className } = readSelected([high, auto])
  assert.equal(node, high)
  assert.equal(className, 'ModelSelect_module_selected__xyz')
})

test('readSelected：没有选中项时返回空，不编造', () => {
  const { node, className } = readSelected([menuItem('High'), menuItem('Auto')])
  assert.equal(node, undefined)
  assert.equal(className, '')
})

test('syncEffortMenu：把勾从 High 搬到 Auto，其余类名一个不丢', () => {
  const off = menuItem('Off')
  const high = menuItem('High', true)
  const auto = menuItem('Auto')
  const doc = menuDoc([off, high, auto])

  const result = syncEffortMenu({ doc, auto: true, autoLabel: 'Auto' })
  assert.equal(result.patched, true)
  assert.deepEqual(auto.state, { className: 'ModelSelect_module_option__abc ModelSelect_module_selected__xyz', checked: 'true' })
  assert.deepEqual(high.state, { className: 'ModelSelect_module_option__abc', checked: 'false' })
  assert.deepEqual(off.state, { className: 'ModelSelect_module_option__abc', checked: 'false' })
})

test('syncEffortMenu：幂等——已经勾在 Auto 上时不再改动', () => {
  const high = menuItem('High', true)
  const auto = menuItem('Auto')
  const doc = menuDoc([high, auto])
  syncEffortMenu({ doc, auto: true, autoLabel: 'Auto' })
  assert.equal(syncEffortMenu({ doc, auto: true, autoLabel: 'Auto' }).patched, false)
})

test('syncEffortMenu：auto 关闭时完全不碰 DOM（勾交回宿主）', () => {
  const high = menuItem('High', true)
  const auto = menuItem('Auto')
  const doc = menuDoc([high, auto])
  assert.deepEqual(syncEffortMenu({ doc, auto: false, autoLabel: 'Auto' }), { patched: false, selected: '' })
  assert.equal(high.state.checked, 'true')
  assert.equal(auto.state.checked, 'false')
})

test('syncEffortMenu：菜单里没有 Auto 项时安静退出', () => {
  const high = menuItem('High', true)
  const doc = menuDoc([high])
  assert.equal(syncEffortMenu({ doc, auto: true, autoLabel: 'Auto' }).patched, false)
  assert.equal(high.state.checked, 'true', '不该把唯一的选中项也弄掉')
})

test('syncEffortMenu：畸形输入不抛错', () => {
  for (const input of [undefined, {}, { doc: null }, { doc: {}, auto: true }]) {
    assert.doesNotThrow(() => syncEffortMenu(input))
  }
})

test('宿主自己就把勾画在 Auto 上时，不重复搬运', () => {
  const high = menuItem('High')
  const auto = menuItem('Auto', true)
  const doc = menuDoc([high, auto])
  const result = syncEffortMenu({ doc, auto: true, autoLabel: 'Auto' })
  assert.equal(result.patched, false)
  assert.equal(auto.state.checked, 'true')
  assert.equal(high.state.checked, 'false')
})
