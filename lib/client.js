/**
 * dsh-auto-effort —— 浏览器半边：输入栏底部的**优化图标 + 开关面板**。
 *
 * ## 为什么换成独立图标
 *
 * 上一版把"选中的 Auto"写进内置模型选择器的触发器（改文字、搬勾）。那条路依赖内置
 * 组件的 DOM 与内部状态，宿主一改就断，而且没法和别的省 token 开关放在一起。
 *
 * 现在换成自己的位置：`conversation.input.right`（模型选择器左边）一个图标按钮，
 * 点开是一个和模型列表同风格的弹层，里面是**一排开关**。
 *
 * ## 开关是登记出来的，不是写死的
 *
 * 面板从宿主读一张登记表（`GET <本插件端点>?switches=1`），表里每项描述一个开关：
 * `{ id, label, hint, endpoint, field, optional }`。任何插件只要实现同一个约定就能进来：
 *
 *   * `GET  <endpoint>` → `{ "enabled": boolean }`
 *   * `POST <endpoint>` body `{ "enabled": boolean }` → `{ "enabled": boolean }`
 *
 * 于是"把开关放进优化面板"不需要改本插件一行代码，也不用碰内置组件的 DOM。
 *
 * ## 约束（踩过的坑，别改）
 *
 * 只 `require('react')` 这一个启动期种子模块；不能 `import`、不能 require 自己包的
 * 子路径——客户端组合会整体失败，应用直接打不开。
 *
 * @module dsh-auto-effort/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-auto-effort',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 本插件在宿主侧的端点：开关登记表与自身状态都从这里读写。 */
    const ENDPOINT = '/dsh-auto-effort'

    const STYLE_ID = 'dsh-auto-effort-style'

    const zh = {
      title: '优化',
      close: '关闭',
      loading: '读取中…',
      failed: '读不到状态，请稍后重试',
      empty: '当前没有可用的开关',
    }
    const en = {
      title: 'Optimize',
      close: 'Close',
      loading: 'Loading…',
      failed: 'Could not read state, try again',
      empty: 'No switches available',
    }

    /**
     * 样式：位置、尺寸、配色都对齐内置控件。
     *
     * 图标按钮与模型选择器的 trigger 同高（28px）、同圆角、同 hover 底色；弹层用
     * `--dsw-alias-bg-paper` 之类的语义变量，深浅色主题都自动跟随。
     */
    const style = `
[data-dsh-opt-root]{position:relative;display:inline-flex;align-items:center}
[data-dsh-opt-icon]{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:28px;min-width:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;
  line-height:20px;cursor:pointer}
[data-dsh-opt-icon]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsh-opt-icon][data-on="1"]{color:var(--dsw-alias-brand-primary)}
[data-dsh-opt-icon]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-dsh-opt-panel]{position:absolute;bottom:calc(100% + 8px);right:0;z-index:60;width:320px;
  padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-module-platform);box-shadow:var(--dsw-elevation-prominent);
  color:var(--dsw-alias-label-primary)}
[data-dsh-opt-head]{display:flex;align-items:center;justify-content:space-between;
  padding:4px 8px 8px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px}
[data-dsh-opt-row]{display:flex;align-items:center;justify-content:space-between;gap:12px;
  min-height:52px;padding:8px;border-radius:var(--dsw-radius-sm);cursor:pointer}
[data-dsh-opt-row]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsh-opt-row]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
[data-dsh-opt-text]{display:flex;flex-direction:column;gap:2px;min-width:0}
[data-dsh-opt-label]{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
[data-dsh-opt-hint]{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
[data-dsh-opt-track]{flex:0 0 auto;position:relative;width:32px;height:18px;border-radius:9px;
  background:var(--dsw-alias-interactive-bg-hover);transition:background .15s ease}
[data-dsh-opt-track][data-on="1"]{background:var(--dsw-alias-brand-primary)}
[data-dsh-opt-thumb]{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb);transition:transform .15s ease}
[data-dsh-opt-track][data-on="1"] [data-dsh-opt-thumb]{transform:translateX(14px)}
[data-dsh-opt-panel[data-busy="1"]{opacity:.6}
`

    /**
     * 读一个开关端点的完整响应；失败返回 undefined。
     *
     * @param {string} endpoint - 端点路径。
     * @returns {Promise<object|undefined>} 响应体。
     */
    async function readEndpoint(endpoint) {
      try {
        const response = await fetch(endpoint, { headers: { accept: 'application/json' } })
        if (response?.ok === false) return undefined
        const body = await response.json()
        return body !== null && typeof body === 'object' ? body : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 读一个开关端点的当前状态。
     *
     * @param {string} endpoint - 端点路径。
     * @param {string} field - 承载布尔值的字段名。
     * @returns {Promise<boolean|undefined>} 状态；读不到返回 undefined。
     */
    async function readSwitch(endpoint, field) {
      const body = await readEndpoint(endpoint)
      const value = body?.[field]
      if (typeof value === 'boolean') return value
      // 兼容旧名：本插件早期只用 `armed` 表示 auto。
      return typeof body?.armed === 'boolean' && field === 'enabled' ? body.armed : undefined
    }

    /**
     * 写一个开关端点。
     *
     * @param {string} endpoint - 端点路径。
     * @param {string} field - 字段名。
     * @param {boolean} value - 目标值。
     * @returns {Promise<boolean|undefined>} 写入后的值；失败返回 undefined。
     */
    async function writeSwitch(endpoint, field, value) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ [field]: value === true }),
        })
        // 端点不在、被拒、返回垃圾：一律 undefined。**不能把没写成功当成功**——
        // 界面会因此显示一个假的开启状态。
        if (response?.ok === false) return undefined
        const body = await response.json()
        const next = body?.[field]
        if (typeof next === 'boolean') return next
        if (typeof body?.armed === 'boolean') return body.armed
        return undefined
      } catch {
        return undefined
      }
    }

    /** 读开关登记表；读不到就返回空表（面板显示"没有可用开关"）。 */
    async function readRegistry() {
      try {
        const response = await fetch(`${ENDPOINT}?switches=1`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        return Array.isArray(body?.switches) ? body.switches : []
      } catch {
        return []
      }
    }

    /**
     * 优化图标 + 弹层。
     *
     * 组件自己不保存真值：每次打开都重新读，写之前先写后端、再用返回值更新界面，
     * 所以两个标签页、刷新、重启之后显示的都是服务端真正生效的值。
     *
     * @returns {object|null} React 元素。
     */
    function OptimizerButton() {
      const [open, setOpen] = React.useState(false)
      const [rows, setRows] = React.useState([])
      const [status, setStatus] = React.useState('loading')
      const rootRef = React.useRef(null)

      /** 拉一次全部开关的状态：同一个端点只请求一次。 */
      const refresh = React.useCallback(async () => {
        const registry = await readRegistry()
        const endpoints = new Map()
        for (const item of registry) {
          if (!endpoints.has(item.endpoint)) endpoints.set(item.endpoint, readEndpoint(item.endpoint))
        }
        const values = new Map()
        for (const [endpoint, promise] of endpoints) values.set(endpoint, await promise)
        const entries = registry.map((item) => {
          const payload = values.get(item.endpoint)
          const field = item.field ?? 'enabled'
          const value = payload === undefined ? undefined : payload[field]
          return { item, on: typeof value === 'boolean' ? value : undefined }
        })
        // 读不到的（没装、404、字段不对）直接不显示，避免"点了没反应"的开关。
        setRows(entries.filter((entry) => typeof entry.on === 'boolean'))
        setStatus(entries.length > 0 ? 'ready' : 'failed')
      }, [])

      React.useEffect(() => {
        if (open) void refresh()
      }, [open, refresh])

      React.useEffect(() => {
        if (!open) return () => {}
        const onDown = (event) => {
          if (rootRef.current?.contains?.(event.target) === true) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      /**
       * 切换一个开关：先写后端，再用后端返回的值更新显示。
       *
       * @param {object} item - 登记项。
       * @param {boolean} next - 目标值。
       */
      const toggle = async (item, next) => {
        const field = item.field ?? 'enabled'
        setStatus('busy')
        const written = await writeSwitch(item.endpoint, field, next)
        setRows((current) =>
          current.map((entry) => (entry.item.id === item.id ? { ...entry, on: written === true } : entry)),
        )
        setStatus('ready')
      }

      const anyOn = rows.some((entry) => entry.on === true)
      const label = document.documentElement?.lang?.startsWith('en') === true ? en : zh

      return React.createElement(
        'div',
        { 'data-dsh-opt-root': '', ref: rootRef },
        React.createElement(
          'button',
          {
            type: 'button',
            'data-dsh-opt-icon': '',
            'data-on': anyOn ? '1' : '0',
            'aria-haspopup': 'true',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': label.title,
            title: label.title,
            onClick: () => setOpen((value) => !value),
          },
          React.createElement(Sparkle),
          React.createElement('span', null, label.title),
        ),
        open
          ? React.createElement(
              'div',
              { 'data-dsh-opt-panel': '', 'data-busy': status === 'busy' ? '1' : '0', role: 'dialog', 'aria-label': label.title },
              React.createElement(
                'div',
                { 'data-dsh-opt-head': '' },
                React.createElement('span', null, label.title),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    'data-dsh-opt-icon': '',
                    'aria-label': label.close,
                    onClick: () => setOpen(false),
                  },
                  '✕',
                ),
              ),
              rows.length === 0
                ? React.createElement('div', { 'data-dsh-opt-hint': '' }, status === 'loading' ? label.loading : label.failed)
                : rows.map(({ item, on }) =>
                    React.createElement(
                      'div',
                      {
                        key: item.id,
                        'data-dsh-opt-row': '',
                        role: 'switch',
                        'aria-checked': on ? 'true' : 'false',
                        tabIndex: 0,
                        onClick: () => void toggle(item, !on),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            void toggle(item, !on)
                          }
                        },
                      },
                      React.createElement(
                        'div',
                        { 'data-dsh-opt-text': '' },
                        React.createElement('span', { 'data-dsh-opt-label': '' }, item.label?.[label === en ? 'en' : 'zh'] ?? item.id),
                        React.createElement('span', { 'data-dsh-opt-hint': '' }, item.hint?.[label === en ? 'en' : 'zh'] ?? ''),
                      ),
                      React.createElement(
                        'span',
                        { 'data-dsh-opt-track': '', 'data-on': on ? '1' : '0' },
                        React.createElement('span', { 'data-dsh-opt-thumb': '' }),
                      ),
                    ),
                  ),
            )
          : null,
      )
    }

    /**
     * 图标：四角星（"优化"的通用符号），跟随文字颜色。
     *
     * @returns {object} React 元素。
     */
    function Sparkle() {
      return React.createElement(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M8 1.5l1.6 4.1 4.1 1.6-4.1 1.6L8 12.9 6.4 8.8 2.3 7.2l4.1-1.6L8 1.5z',
        }),
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M12.6 11.1l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7z',
        }),
      )
    }

    exports.inject = ['slots']

    /**
     * 客户端插件主体：注入样式，把优化图标放进输入栏底部那一排。
     *
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
        const node = document.createElement('style')
        node.id = STYLE_ID
        node.textContent = style
        document.head.append(node)
      }
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'auto-effort-optimizer', order: 20 },
          OptimizerButton,
        ),
      )
    }

    exports.apply = apply
    exports.readRegistry = readRegistry
    exports.readSwitch = readSwitch
    exports.writeSwitch = writeSwitch
    return module.exports
  },
})
