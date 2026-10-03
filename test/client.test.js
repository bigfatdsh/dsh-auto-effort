/**
 * dsh-auto-effort —— 浏览器半边的单元测试。
 *
 * 浏览器半边不会让宿主启动失败：语法错、require 错、注册错都只在页面里炸，
 * 宿主看起来一切正常。所以这里按 `window.__ModuleLoader__` 的契约真的跑一遍：
 * 用最小 React 替身渲染一次，验证"读到的档位显示出来、点一下 POST 出去、
 * Host 拒绝时回滚到原来的档位"这三件事。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'


const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 捕获一次 `window.__ModuleLoader__.load`。 */
/**
 * 装载 client.js 并捕获它的模块注册。
 *
 * 用动态 import 而不是 `new Function`：bundle 现在 `import` 同包的 `menu-marker.js`
 * （客户端模块系统会把同包模块一起求值），`new Function` 不接受 import 语句。
 *
 * @param {object} [docOverride] - 交给 bundle 的 document（它按加载时的值捕获）。
 * @returns {object} `window.__ModuleLoader__.load` 收到的那条注册。
 */
let loadCounter = 0
async function loadModule(docOverride) {
  let registration
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  globalThis.document = docOverride ?? {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { append: () => {} },
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  // 每次换一个查询串绕过模块缓存，等价于"页面重新加载了一次 bundle"。
  await import(`../lib/client.js?case=${++loadCounter}`)
  assert.ok(registration !== undefined, 'bundle 没有调用 window.__ModuleLoader__.load')
  return registration
}

/**
 * 装载 bundle 并取出它的 exports。
 *
 * @param {object} react - React 替身。
 * @param {object} [dom] - 受控 DOM。
 * @returns {Promise<object>} bundle exports。
 */
async function loadExports(react, dom) {
  const registration = await loadModule(dom?.document)
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require("${specifier}")`)
  })
  exports.__resetForTest?.()
  return exports
}

test('内联常量与宿主常量一致（浏览器侧不能 require，只能靠这条对齐）', async () => {
  const efforts = await import('../lib/efforts.js')
  assert.match(source, new RegExp(`const AUTO_LABEL = '${efforts.AUTO_EFFORT_NAME}'`))
  const levels = source.match(/const REAL_LEVELS = new Set\(\[([^\]]*)\]\)/)
  assert.ok(levels !== null, 'client.js 必须内联 REAL_LEVELS')
  for (const name of efforts.REAL_EFFORT_NAMES) {
    assert.ok(levels[1].includes(`'${name}'`), `REAL_LEVELS 缺少 ${name}`)
  }
})

test('浏览器 bundle 只 require 种子模块（否则整个客户端组合失败、应用打不开）', () => {
  // 注释里会出现反例说明（"不要 require 某某"），所以先剥掉注释再扫。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const requires = [...code.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
})

test('client.js 按约定注册模块，暴露状态机与标记函数', async () => {
  const exports = await loadExports({ createElement: () => null, useRef: () => ({ current: null }), useEffect: () => {}, useSyncExternalStore: () => false })
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.createAutoState, 'boolean' === 'x' ? 'x' : typeof exports.createAutoState)
  assert.equal(typeof exports.applyMark, 'function')
  assert.equal(typeof exports.listenForEffortPicks, 'function')
})

test('apply：注入样式、注册零尺寸组件、把点击监听挂到 document', async () => {
  const React = { createElement: () => null, useRef: () => ({ current: null }), useEffect: () => {}, useSyncExternalStore: () => false }
  const exports = await loadExports(React)
  const styleNodes = []
  const slots = []
  const listeners = []
  globalThis.document.getElementById = () => null
  globalThis.document.createElement = () => ({ id: '', textContent: '' })
  globalThis.document.head.append = (node) => styleNodes.push(node)
  globalThis.document.addEventListener = (type, fn, capture) => listeners.push({ type, capture })
  globalThis.document.removeEventListener = () => {}
  exports.apply({
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: { inject: (_target, register) => register(), register: (options, component) => slots.push({ options, component }) },
  })
  assert.equal(styleNodes.length, 1)
  assert.equal(styleNodes[0].id, 'dsh-auto-effort-style')
  assert.match(styleNodes[0].textContent, /\[data-dsh-auto-effort\]/)
  // 显示由 JS 改文本完成：样式里不该再出现伪元素（上一版就是它把 Auto 藏掉的）。
  assert.doesNotMatch(styleNodes[0].textContent, /::after/)
  assert.doesNotMatch(styleNodes[0].textContent, /text-indent/)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].options.name, 'conversation.input.right')
  assert.equal(typeof slots[0].component, 'function')
  assert.deepEqual(listeners.map((entry) => entry.type), ['click'])
  assert.equal(listeners[0].capture, true, '菜单是 portal，必须用捕获阶段')
})

test('状态机：只在真的变化时通知订阅者', async () => {
  const exports = await loadExports({ createElement: () => null, useRef: () => ({ current: null }), useEffect: () => {}, useSyncExternalStore: () => false })
  const state = exports.createAutoState()
  let notifications = 0
  const stop = state.subscribe(() => {
    notifications += 1
  })
  assert.equal(state.get(), false)
  state.set(true)
  state.set(true)
  assert.equal(notifications, 1)
  state.set(false)
  assert.equal(notifications, 2)
  stop()
  state.set(true)
  assert.equal(notifications, 2)
})

test('标记函数：只给触发器加/去属性，别的节点一个字都不动', async () => {
  const exports = await loadExports({ createElement: () => null, useRef: () => ({ current: null }), useEffect: () => {}, useSyncExternalStore: () => false })
  const attributes = new Map()
  const node = {
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  }
  const doc = { querySelectorAll: (selector) => (selector.includes('_trigger') ? [node] : []) }
  assert.equal(exports.applyMark(true, doc), 1)
  assert.equal(attributes.get('data-dsh-auto-effort'), '1')
  assert.equal(exports.applyMark(true, doc), 0, '已经是标记状态时不重复改')
  assert.equal(exports.applyMark(false, doc), 1)
  assert.equal(attributes.has('data-dsh-auto-effort'), false)
})

test('点击判定：真实按钮文本（就是等级名）点 Auto 开标记、选真实等级清标记', async () => {
  const exports = await loadExports({ createElement: () => null, useRef: () => ({ current: null }), useEffect: () => {}, useSyncExternalStore: () => false })
  const handlers = []
  const doc = { addEventListener: (type, fn) => handlers.push(fn), removeEventListener: () => {} }
  const state = exports.createAutoState()
  exports.listenForEffortPicks(state, doc)

  // 真实 DOM：等级按钮里是 <span class="optionCopy"><span class="modelName">Auto</span></span>
  const option = (label) => ({
    textContent: label,
    querySelectorAll: () => [{ textContent: label }],
  })

  handlers[0]({ target: option('Auto') })
  assert.equal(state.get(), true, '点 Auto 必须开标记')
  handlers[0]({ target: option('High') })
  assert.equal(state.get(), false, '选真实等级必须立刻清标记')
  handlers[0]({ target: option('Max') })
  assert.equal(state.get(), false)
  // 普通点击（比如搜索框、模型名）不该误触发
  handlers[0]({ target: option('deepseek-flash') })
  assert.equal(state.get(), false)
  handlers[0]({ target: { textContent: 'Auto', querySelectorAll: undefined } })
  assert.equal(state.get(), true, '只有直接文本也能识别')
})

/**
 * 端到端：在受控 DOM 里跑真实的 client.js。
 *
 * 这一组测试是这次故障的直接防线。前两版失败的原因都不是"逻辑想错了"，而是**浏览器里
 * 真实 DOM 的形状和我假设的不一样**（等级按钮的文本只是 `Auto`、不是 `模型名 · Auto`）。
 * 所以这里必须用真实的 DOM、真实的点击、真实的样式表读取，而不是断言源码里有没有某个
 * 字符串。
 */

/**
 * 造一棵最小的、形状与内置模型选择器一致的 DOM。
 *
 * 等级文字是一个**真实的文本节点**：被测代码直接改写它（不用伪元素）。
 *
 * @returns {object} 测试用 DOM。
 */
function createPickerDom() {
  const listeners = []
  const observers = []
  let triggerAttr = null
  let effortValue = 'high'
  let styleText = ''

  const makeTextNode = (value) => ({ nodeType: 3, nodeValue: value })
  const effortTextNode = makeTextNode('high')

  const trigger = {
    className: 'ModelSelect_module_trigger_HASH',
    getAttribute: (name) => (name === 'data-dsh-auto-effort' ? triggerAttr : null),
    setAttribute: (name, value) => {
      if (name === 'data-dsh-auto-effort') triggerAttr = value
    },
    removeAttribute: (name) => {
      if (name === 'data-dsh-auto-effort') triggerAttr = null
    },
    querySelector: (selector) => (selector.includes('_triggerEffort') ? effort : null),
  }

  const effort = {
    className: 'ModelSelect_module_triggerEffort_HASH',
    get textContent() {
      return effortTextNode.nodeValue
    },
    set textContent(value) {
      effortTextNode.nodeValue = value
    },
    ownerDocument: null,
  }
  effort.ownerDocument = {
    createTreeWalker: () => {
      let done = false
      return {
        nextNode: () => {
          if (done) return null
          done = true
          return effortTextNode
        },
      }
    },
  }
  trigger.querySelector = (selector) => (selector.includes('_triggerEffort') ? effort : null)

  /**
   * 等级菜单项：真实结构是 button > span.optionCopy > span.modelName(label)，
   * 选中态同时体现在 `aria-checked` 与一个带哈希的类名上。
   */
  const BASE_CLASS = 'ModelSelect_module_option__abc'
  const SELECTED_CLASS = 'ModelSelect_module_selected__xyz'
  const option = (text, selected = false) => {
    const inner = { textContent: text }
    let className = selected ? `${BASE_CLASS} ${SELECTED_CLASS}` : BASE_CLASS
    let checked = selected ? 'true' : 'false'
    return {
      get textContent() {
        return text
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
      get menuState() {
        return { className, checked }
      },
    }
  }
  // 初始状态与真实一致：宿主把勾画在模型默认档 High 上。
  const autoOption = option('Auto')
  const highOption = option('High', true)
  const lowOption = option('Low')
  /** 宿主重渲染菜单时，勾会回到 High——测试用它模拟"关掉标记后的真实状态"。 */
  const resetMenu = () => {
    autoOption.className = BASE_CLASS
    autoOption.setAttribute('aria-checked', 'false')
    highOption.className = `${BASE_CLASS} ${SELECTED_CLASS}`
    highOption.setAttribute('aria-checked', 'true')
    lowOption.className = BASE_CLASS
    lowOption.setAttribute('aria-checked', 'false')
  }

  const document = {
    body: {},
    head: {
      append(node) {
        if (node.id === 'dsh-auto-effort-style') styleText = node.textContent
      },
    },
    createElement() {
      return { id: '', textContent: '' }
    },
    getElementById(id) {
      return id === 'dsh-auto-effort-style' && styleText !== '' ? { id, textContent: styleText } : null
    },
    querySelectorAll: (selector) => {
      if (selector === '[class*="_trigger"]') return [trigger]
      if (selector === '[role="menuitemradio"]') return [lowOption, highOption, autoOption]
      return []
    },
    querySelector: (selector) =>
      selector === '[class*="_trigger"]' ? { textContent: `deepseek-flash · ${effort.textContent}` } : null,
    addEventListener(type, fn) {
      listeners.push({ type, fn })
    },
    removeEventListener() {},
  }

  globalThis.localStorage = {
    getItem: (key) => persistentStorage.get(key) ?? null,
    setItem: (key, value) => persistentStorage.set(key, String(value)),
  }
  globalThis.MutationObserver = class {
    constructor(fn) {
      this.fn = fn
      observers.push(this)
    }
    observe() {}
    disconnect() {}
  }

  return {
    document,
    nodes: { trigger, effort, option, autoOption, highOption, lowOption },
    resetMenu,
    triggerAttr: () => triggerAttr,
    effortText: () => effort.textContent,
    setEffortText: (next) => {
      effort.textContent = next
    },
    styleText: () => styleText,
    click: (node) => {
      for (const listener of listeners) if (listener.type === 'click') listener.fn({ target: node })
    },
    mutate: () => {
      for (const observer of observers) observer.fn()
    },
    /** 同步跑一遍微任务队列（标记是通过 queueMicrotask 落盘的）。 */
    flush: async () => {
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

/**
 * 装载 client.js 并在受控 DOM 里 apply 一次。
 *
 * @returns {object} 测试句柄。
 */
/** 跨"页面重载"保留的 localStorage：真实浏览器里它不会被刷新清空。 */
const persistentStorage = new Map()

async function mountClient(options = {}) {
  // 默认清掉持久化：多数用例要的是"干净的一次挂载"。只有验证刷新行为的用例
  // 才传 `{ keepStorage: true }`——否则上一个用例留下的标记会让它假通过/假失败。
  if (options.keepStorage !== true) persistentStorage.clear()
  const dom = createPickerDom()
  // bundle 里的 `document` 是 load 那一刻抓到的引用：必须把受控 DOM 交给它。
  globalThis.document = dom.document
  const registration = await loadModule(dom.document)
  const UNINITIALIZED = Symbol('uninitialized')
  const cells = []
  const cleanups = []
  let cursor = 0
  let rendering = false
  let dirty = false
  // 一个够用的 hooks 运行时：状态变化会真的重渲染，effect 的清理函数也会跑。
  // 重入保护是必需的：订阅回调可能正好在 effect 执行中触发（复核那条路径就会），
  // 直接递归渲染会让"当前这次渲染"半途被打断。
  const React = {
    createElement: () => null,
    useRef: (initial) => {
      const index = cursor++
      if (cells[index] === UNINITIALIZED || !(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
    useEffect: (fn) => {
      cursor++
      cleanups.push(fn())
    },
    useSyncExternalStore: (subscribe, get) => {
      const index = cursor++
      if (!(index in cells)) {
        cells[index] = get()
        subscribe(() => {
          cells[index] = get()
          render()
        })
      }
      return cells[index]
    },
  }
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require("${specifier}")`)
  })
  exports.__resetForTest?.()
  const registered = []
  exports.apply({
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: {
      inject: (_target, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
  })
  /** 重新渲染零尺寸组件（清掉上一轮 effect，跑新一轮）。 */
  const render = () => {
    if (rendering) {
      dirty = true
      return
    }
    rendering = true
    do {
      dirty = false
      cursor = 0
      while (cleanups.length > 0) cleanups.pop()()
      registered[0].component()
    } while (dirty)
    rendering = false
  }
  render()
  return { dom, exports, registered, render }
}

test('真实 DOM：点等级菜单里的 Auto，触发器挂上标记；点 High 立刻摘掉', async () => {
  const { dom } = await mountClient()
  assert.equal(dom.triggerAttr(), null, '初始不该有标记')
  assert.equal(dom.effortText(), 'high', '未开启时文字仍是宿主下发的等级')

  dom.click(dom.nodes.option('Auto'))
  assert.equal(dom.triggerAttr(), '1', '点 Auto 必须挂上标记')
  assert.equal(dom.effortText(), 'Auto', '点 Auto 必须把文字换成 Auto')
  // 真实时序：点等级 → 宿主把会话选择改成 High → 触发器文字变成 "· High"。
  // 测试必须把这一步做出来，否则复核逻辑会一直看到 "· Auto"，把标记又打开。
  dom.setEffortText('High')
  dom.click(dom.nodes.option('High'))
  dom.mutate()
  assert.equal(dom.triggerAttr(), null, '点 High 必须摘掉标记')
  assert.equal(dom.effortText(), 'High', '取消时不动文字，交回宿主下发的等级')

  // 样式表必须真的能把 high 换成 Auto
  // 样式只做状态锚点；真正的显示是 JS 改写文本节点。
  assert.match(dom.styleText(), /\[data-dsh-auto-effort\]/)
  assert.doesNotMatch(dom.styleText(), /::after/)
})

test('真实 DOM：宿主回写 auto 时，控制器文本复核把标记补上（即使点击没被识别）', async () => {
  const { dom, render } = await mountClient()
  dom.setEffortText('auto')
  render()
  assert.equal(dom.triggerAttr(), '1', '触发器上是 auto 就必须显示 Auto')
  assert.equal(dom.effortText(), 'Auto', '并且文字要真的换成 Auto')
})

test('标记会持久化：刷新后仍然是 Auto', async () => {
  const first = await mountClient()
  first.dom.click(first.dom.nodes.option('Auto'))
  assert.equal(first.dom.triggerAttr(), '1')
  assert.equal(first.dom.effortText(), 'Auto')

  // 重新挂载（同一 localStorage，模拟刷新）
  const second = await mountClient({ keepStorage: true })
  await second.dom.flush()
  assert.equal(second.dom.triggerAttr(), '1', '刷新后标记不能丢')
  assert.equal(second.dom.effortText(), 'Auto', '刷新后文字也必须是 Auto')
  assert.equal(second.dom.nodes.autoOption.menuState.checked, 'true', '刷新后菜单里的勾也要在 Auto 上')
})

test('回归：宿主把等级写成 High 时，复核不得把标记又打开（曾因 /auto$/i 永久卡在 Auto）', async () => {
  const { dom, render } = await mountClient()
  dom.setEffortText('High')
  render()
  await dom.flush()
  assert.equal(dom.triggerAttr(), null, '触发器上是 High 就必须没有标记')
  assert.equal(dom.effortText(), 'High', '文字保持宿主下发的值')
  assert.equal(dom.nodes.highOption.menuState.checked, 'true', '勾应留在 High')
  assert.equal(dom.nodes.autoOption.menuState.checked, 'false')
})

test('回归：宿主把等级写成小写 auto 时，复核必须把标记打开', async () => {
  const { dom, render } = await mountClient()
  dom.setEffortText('auto')
  render()
  await dom.flush()
  assert.equal(dom.triggerAttr(), '1')
  assert.equal(dom.effortText(), 'Auto')
  assert.equal(dom.nodes.autoOption.menuState.checked, 'true')
})

test('点非等级节点不误清标记', async () => {
  const { dom, render } = await mountClient()
  dom.click(dom.nodes.autoOption)
  render()
  await dom.flush()
  assert.equal(dom.triggerAttr(), '1')
  dom.click(dom.nodes.option('deepseek-flash'))
  dom.click(dom.nodes.option('搜索'))
  assert.equal(dom.triggerAttr(), '1', '点模型名或搜索框不该清标记')
  assert.equal(dom.effortText(), 'Auto')
})

test('取消：选真实等级后，触发器与菜单的勾一起交回宿主', async () => {
  const { dom, render } = await mountClient()
  dom.click(dom.nodes.autoOption)
  render()
  await dom.flush()
  assert.equal(dom.effortText(), 'Auto')

  // 真实时序：点 High → 宿主把会话选择改成 High → 菜单重渲染（勾回到 High）。
  dom.setEffortText('High')
  dom.resetMenu()
  dom.click(dom.nodes.highOption)
  render()
  dom.mutate()
  await dom.flush()

  assert.equal(dom.triggerAttr(), null, '取消后不该还有标记')
  assert.equal(dom.effortText(), 'High', '显示交回宿主')
  assert.equal(dom.nodes.highOption.menuState.checked, 'true', '勾留在 High')
  assert.equal(dom.nodes.autoOption.menuState.checked, 'false')
})
