/**
 * dsh-auto-effort —— 浏览器半边：把"你点了 Auto"这件事显示在模型选择器的触发器上。
 *
 * ## 为什么需要它
 *
 * `Auto` 是插件往推理等级列表里追加的一条（宿主侧 `resolveModelInfo` 做的），点它
 * 真的会生效——但它不是一个模型自带的档位，宿主回读会话选择时会把"与默认档相同"的
 * 值丢掉，触发器于是显示成模型默认档（如 high），看起来像没点上。
 *
 * 所以这里做一个**纯展示层**的补充：点过 Auto 就把触发器上的等级改写成 `Auto`；
 * 一旦你在列表里选了任何一个真实等级，标记立即消失、显示交回宿主。判定本身完全在
 * 宿主侧，这里不参与、不假设、不缓存任何档位。
 *
 * ## 为什么用 DOM 标记而不是包住选择器
 *
 * 模型选择器是内置客户端包，插件不能改它的渲染。但它暴露了两个稳定标识：触发器上的
 * `[class*="_trigger"]` / `[class*="_triggerEffort"]`、以及等级按钮的文本。加上
 * `data-dsh-auto-effort` 属性后，用 CSS 就能把触发器上的等级换成 `Auto`——不动 React
 * 状态，也不会和内置重渲染打架。
 *
 * @module dsh-auto-effort/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-auto-effort',
  factory: (require) => {
    // 档位常量在这里内联，**不能用 require('dsh-auto-effort/efforts')**：浏览器里的
    // bundle 只能 require 启动期种子模块（react），请求自己包的子路径会让整个客户端
    // 组合失败——应用会直接打不开（真实踩过）。一致性由单测保证：
    // test/client.test.js 里有一条断言把这里的字面量与 lib/efforts.js 对齐。
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 虚拟档位的显示名：必须与 `lib/efforts.js` 的 `AUTO_EFFORT_NAME` 相同。 */
    const AUTO_LABEL = 'Auto'

    /** 真实等级的显示名（宿主目录里的 name）：必须与 `REAL_EFFORT_NAMES` 相同。 */
    const REAL_LEVELS = new Set(['Off', 'Low', 'Medium', 'High', 'Max'])

    /** 宿主端点：手动取消 Auto 时通知一句（只影响端点里的诊断显示）。 */
    const ENDPOINT = '/dsh-auto-effort'

    /** 标记属性：样式与自检都靠它。 */
    const MARK = 'data-dsh-auto-effort'

    /** 触发器上的模型名与等级两个类（CSS Module 带哈希前缀，用后缀匹配）。 */
    const TRIGGER_EFFORT = '[class*="_triggerEffort"]'
    const TRIGGER = '[class*="_trigger"]'

    /**
     * 样式：只给标记状态一个类名。
     *
     * 这里**不用伪元素**：隐藏原文字的任何手段（`text-indent`、`font-size: 0`）都会
     * 连带影响 `::after`——前者把 Auto 一起推出可视区（"Auto 直接消失"），后者把
     * Auto 顶到行盒顶部。所以显示由 JS 直接替换文本节点，样式不参与。
     */
    const style = `
[${MARK}] {
  /* 只作为状态锚点；具体显示由 JS 改文本完成。 */
  --dsh-auto-effort-active: 1;
}
`

    /**
     * 极小的可订阅状态：记"用户点过 Auto"。
     *
     * 纯内存：刷新页面后标记消失，但**判定不受影响**——真正的档位在宿主那一侧。
     * 一个只影响显示标记的值，不值得再添一处状态文件。
     *
     * @returns {{get: () => boolean, set: (next: boolean) => void, subscribe: (listener: () => void) => () => void}} 状态容器。
     */
    /** 标记的持久化键：只存"点过 Auto"这一个布尔值。 */
    const STORE_KEY = 'dsh-auto-effort:auto'

    /** 读取持久化的标记；任何异常都当 false。 */
    function readStored() {
      try {
        return globalThis.localStorage?.getItem(STORE_KEY) === '1'
      } catch {
        return false
      }
    }

    /** 写入持久化标记；写不进去也无所谓，内存值仍然正确。 */
    function writeStored(next) {
      try {
        globalThis.localStorage?.setItem(STORE_KEY, next ? '1' : '0')
      } catch {
        // 隐私模式/配额满：忽略。
      }
    }

    function createAutoState() {
      let value = readStored()
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (value === next) return
          value = next
          writeStored(next)
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * 监听"用户点了哪个等级"。
     *
     * 捕获阶段挂在 document 上：菜单是 portal，等它冒泡到插件自己的节点之前就会
     * 被这里看到。
     *
     * @param {object} state - {@link createAutoState} 的返回值。
     * @param {Document|object} doc - 文档对象。
     * @returns {() => void} 取消监听。
     */
    function listenForEffortPicks(state, doc) {
      const onPick = (event) => {
        const node = event?.target
        if (node === null || node === undefined) return
        // 等级按钮的文本**就是**等级名（模型名只在触发器上，带 " · "）。所以取被点
        // 节点自己与它内部元素的文本，逐个与目录里的等级名比对——不依赖按钮的类名，
        // 也不假设 DOM 结构，宿主换一套样式也照样成立。
        const candidates = new Set()
        if (typeof node.textContent === 'string') candidates.add(node.textContent.trim())
        if (typeof node.querySelectorAll === 'function') {
          for (const child of node.querySelectorAll('span, div')) {
            if (typeof child.textContent === 'string') candidates.add(child.textContent.trim())
          }
        }
        if (candidates.size === 0) return
        const auto = candidates.has(AUTO_LABEL)
        if (!auto) {
          // 只有"命中了目录里某个真实等级名"才算用户手动取消，避免普通点击误清标记。
          if (!hasRealLevel(candidates)) return
        }
        state.set(auto)
        if (!auto) void notifyHostCancel()
      }
      doc.addEventListener('click', onPick, true)
      return () => doc.removeEventListener('click', onPick, true)
    }

    /**
     * 判断一次点击是不是"选了某个真实推理等级"。
     *
     * @param {Set<string>} candidates - 被点节点上的文本候选。
     * @returns {boolean} 是否命中真实等级名。
     */
    function hasRealLevel(candidates) {
      for (const candidate of candidates) {
        if (candidate !== '' && candidate !== AUTO_LABEL && REAL_LEVELS.has(candidate)) return true
      }
      return false
    }

    /** 告诉宿主"手动取消了自动"：让端点里的最近一次判定不误导排查。 */
    async function notifyHostCancel() {
      try {
        await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ auto: false }),
        })
      } catch {
        // 通知失败无所谓：标记已经关掉，判定一直由宿主负责。
      }
    }

    /**
     * 把标记写进 DOM。
     *
     * 做两件事：给触发器加状态属性（供样式/自检锚定），并把触发器上的**等级文字**
     * 直接换成 `Auto`。替换文本节点而不是用伪元素，理由见上面的样式注释。
     *
     * @param {boolean} on - 是否处于"点过 Auto"。
     * @param {Document|object} doc - 文档对象。
     * @returns {number} 被改动的触发器数量。
     */
    function applyMark(on, doc) {
      const triggers = doc.querySelectorAll(TRIGGER)
      let changed = 0
      for (const trigger of triggers) {
        const flagged = trigger.getAttribute?.(MARK) === '1' || trigger.getAttribute?.(MARK) === ''
        if (on === flagged) continue
        if (on) trigger.setAttribute?.(MARK, '1')
        else trigger.removeAttribute?.(MARK)
        changed += 1
      }
      return changed
    }

    /**
     * 把标记状态画到触发器上：加/去属性 + 改写等级文字。
     *
     * `真值性` 与属性用同一个来源，所以 React 重渲染把文本改回去时，MutationObserver
     * 触发的下一次 paint 会再改回来。
     *
     * @param {boolean} on - 是否处于"点过 Auto"。
     * @returns {number} 被改动的触发器数量。
     */
    function paint(on) {
      const changed = applyMark(on, document)
      for (const trigger of document.querySelectorAll(TRIGGER)) {
        const effort = trigger.querySelector?.(TRIGGER_EFFORT)
        if (effort === null || effort === undefined) continue
        // 关闭时不动文字：宿主下一次渲染会写下真实等级；主动还原反而会拿旧值覆盖它。
        if (on) setNodeText(effort, AUTO_LABEL)
      }
      return changed
    }

    /**
     * 改写一个元素里的文本节点。
     *
     * @param {object} container - 承载文本的元素。
     * @param {string|null} text - 要写入的文字；`null` 表示还原成宿主下发的值。
     */
    function setNodeText(container, text) {
      // 不缓存"原值"：那会把开启前的旧文字记下来，取消时盖掉宿主下发的新值。
      // 需要还原时不写任何东西——宿主的重渲染会把等级文字自己刷回来。
      const target = text
      if (typeof target !== 'string' || target === '') return
      if (container.textContent.trim() === target) return
      const walker = container.ownerDocument?.createTreeWalker?.(container, 4)
      if (walker !== undefined) {
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (typeof node.nodeValue === 'string' && node.nodeValue.trim() !== '') {
            node.nodeValue = target
            return
          }
        }
      }
      // 没有文本节点可改（或宿主没提供 TreeWalker）时退回整段文本。
      if (typeof container.textContent === 'string' && typeof container.nodeType === 'number') {
        try {
          container.textContent = target
        } catch {
          // 只读节点：放弃改写，属性标记仍然生效。
        }
      }
    }

    /**
     * 全局唯一的自动标记状态。
     *
     * **必须共享**：点击监听挂在 document 上（与渲染无关），组件负责把它写进 DOM。
     * 两边各建一个实例的话，点击改的是 A、订阅的是 B——标记永远不出现。这不是理论
     * 问题，是上一版真实踩过的坑。
     */
    let sharedState = null
    let sharedLoaded = false

    /**
     * 取共享状态，必要时创建。
     *
     * @returns {object} {@link createAutoState} 的返回值。
     */
    function autoState() {
      if (!sharedLoaded) {
        sharedLoaded = true
        sharedState = createAutoState()
        globalThis.__DSH_AUTO_EFFORT__ = sharedState
      }
      return sharedState
    }

    /** 零尺寸组件：把状态写进 DOM，并保证后来出现的触发器也会被标上。 */
    function AutoEffortMarker() {
      const state = autoState()
      // 订阅只负责"变化时重渲染"；渲染时不使用这个快照值，避免陈旧值覆盖显示。
      React.useSyncExternalStore(state.subscribe, state.get, state.get)

      React.useEffect(() => {
        // 一律以真实状态为准：订阅快照在重渲染时可能还是旧值，用它去"还原"文字
        // 会把刚写上去的 Auto 又盖回宿主下发的等级。
        applyMark(autoState().get(), document)
        paint(autoState().get())
        // 复核：触发器的等级文字是权威事实。用户选了 Auto 之后，宿主会把会话里的
        // `auto` 写回，触发器上就会出现 ` · auto`。看到它就把标记补上——即使点击
        // 那一下没被认出来（菜单是 portal、文本形态随宿主变化），也能对齐。
        const reconcile = () => {
          const text = document.querySelector(TRIGGER)?.textContent
          if (typeof text === 'string' && /·\s*auto\s*$/i.test(text)) {
            state.set(true)
            return
          }
          paint(autoState().get())
        }
        reconcile()
        if (typeof MutationObserver !== 'function') return () => {}
        // 换会话、折叠、切换布局都会重建触发器，属性要跟着补上。
        let scheduled = false
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          queueMicrotask(() => {
            scheduled = false
            reconcile()
            applyMark(state.get(), document)
          })
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        return () => observer.disconnect()
      }, [state])

      return null
    }

    /** 需要的服务：slot 注册表（借它挂一个零尺寸组件）。 */
    const inject = ['slots']

    /**
     * 客户端插件主体。
     *
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-auto-effort-style') === null) {
        const node = document.createElement('style')
        node.id = 'dsh-auto-effort-style'
        node.textContent = style
        document.head.append(node)
      }
      const stopListening = listenForEffortPicks(autoState(), document)
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'auto-effort', order: 11 },
          AutoEffortMarker,
        ),
      )
      ctx.effect?.(() => stopListening, 'auto-effort: effort pick listener')
    }

    exports.apply = apply
    exports.inject = inject
    exports.createAutoState = createAutoState
    // 自检用：把共享状态丢掉，下次访问重新从持久化里读——等价于"刷新了一次页面"。
    exports.__resetForTest = () => {
      sharedLoaded = false
      sharedState = null
    }
    exports.applyMark = applyMark
    exports.listenForEffortPicks = listenForEffortPicks
    return module.exports
  },
})
