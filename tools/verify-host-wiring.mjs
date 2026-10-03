/**
 * 装配自检：用真实插件模块跑一遍"一个请求进来，推理强度被改成什么"。
 *
 * 单测覆盖的是判定逻辑本身，这里覆盖的是**接线**：`apply` 注册的那个监听者，
 * 在真实的 `llm/stream` 瀑布形状下（冻结的 options、`next()` 收尾、异步迭代器）
 * 到底把请求交给了谁、带着什么 effort。这类错误单测抓不到，跑起来却只表现为
 * "插件好像没生效"。
 *
 * 用法：node tools/verify-host-wiring.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROUTE_PATH, apply } from '../lib/index.js'


/** 一份冻结的请求，形状与 dsh-agent-loop 交给瀑布的一致。 */
function frozenRequest(text, extra = {}) {
  return Object.freeze({
    provider: 'deepseek',
    model: 'deepseek-flash',
    messages: Object.freeze([Object.freeze({ role: 'user', content: text })]),
    system: 'sys',
    tools: Object.freeze([Object.freeze({ name: 'read', description: '', parameters: {} })]),
    sessionId: 'session-test',
    ...extra,
  })
}

/** 只提供 llm/stream 的假 ctx，但事件语义按 Cordis 的瀑布实现。 */
function fakeHost({ resolveModelInfo, stateHome }) {
  const listeners = []
  const routes = []
  const logs = []
  const dispatched = []
  const events = new EventEmitter()

  // 注入语义：`ctx.llm` / `ctx.webServer` 直接可用（生产里由 inject 保证）。
  // `get` 用取值器实时读 `services`——`llm` 在下面才挂上来，早绑定会永远拿到 undefined。
  const services = {
    webServer: { register: (route) => (routes.push(route), () => {}) },
  }
  const ctx = {
    get: (key) => services[key],
    get llm() {
      return services.llm
    },
    get webServer() {
      return services.webServer
    },
    on(name, listener) {
      assert.equal(name, 'llm/stream')
      listeners.push(listener)
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(`WARN ${message}`),
    },
  }

  services.llm = {
    resolveModelInfo,
    /** 直接的 dispatch：不经过瀑布，代表适配器最终拿到的东西。 */
    stream(options) {
      dispatched.push(options)
      return (async function* chunks() {
        yield { type: 'text', text: 'ok' }
        yield { type: 'finish', kind: 'completed' }
      })()
    },
  }

  /**
   * 按 Cordis 的方式触发瀑布：外层监听者先跑，不调用 next() 就是否决。
   *
   * @param {object} options - 请求。
   * @returns {Promise<string[]>} 收到的 chunk 摘要。
   */
  async function waterfall(options) {
    const queue = listeners.slice()
    const next = () => (queue.shift() ?? (() => ctx.llm.stream(options)))(options, next)
    const stream = next()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk.type)
    return chunks
  }

  return { ctx, waterfall, dispatched, routes, logs, events, stateHome, services }
}

const home = await mkdtemp(join(tmpdir(), 'auto-effort-verify-'))
try {
  const efforts = ['off', 'low', 'high', 'max']
  const host = fakeHost({
    resolveModelInfo: async () => ({ provider: 'deepseek', id: 'deepseek-flash', name: 'Flash', reasoning: { efforts, defaultEffort: 'off' } }),
    stateHome: home,
  })

  // 状态文件写到临时目录，不碰真实 ~/.dsh。
  process.env.DSH_HOME = home
  apply(host.ctx, { mode: 'auto', log: true })
  await new Promise((resolve) => setImmediate(resolve))

  // 1) 复杂任务：适配器必须收到被判定的 effort。
  const heavy = '帮我修一下这个接口的报错，并且补上回归测试：第一步先复现，第二步定位根因，第三步修复并跑全量测试。'
  const heavyChunks = await host.waterfall(frozenRequest(heavy))
  assert.deepEqual(heavyChunks, ['text', 'finish'])
  assert.equal(host.dispatched.length, 1)
  assert.ok(['high', 'max'].includes(host.dispatched[0].reasoningEffort), `heavy → ${host.dispatched[0].reasoningEffort}`)
  assert.match(
    host.logs.find((line) => line.includes('tier=')) ?? '',
    /effort=(high|max)\b/,
    `决策日志必须报出落成的 effort：${host.logs.join(' | ')}`,
  )
  assert.equal(host.dispatched[0].provider, 'deepseek')
  assert.equal(host.dispatched[0].messages.length, 1, '消息数组必须原样带下去')

  // 2) 简单问候：降到 off。
  await host.waterfall(frozenRequest('你好'))
  assert.equal(host.dispatched[1].reasoningEffort, 'off')

  // 3) 续跑请求：一个字都不动（这里请求上带着 max，必须保持 max）。
  await host.waterfall(
    Object.freeze({
      provider: 'deepseek',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      messages: Object.freeze([
        Object.freeze({ role: 'user', content: '帮我改这个函数' }),
        Object.freeze({ role: 'tool', content: 'done', toolCallId: 'c1' }),
      ]),
    }),
  )
  assert.equal(host.dispatched[2].reasoningEffort, 'max', '续跑不得中途改强度')

  // 4) 辅助调用（会话标题）不参与判定。
  await host.waterfall(frozenRequest('你好', { purpose: 'session-title', reasoningEffort: 'off' }))
  assert.equal(host.dispatched[3].reasoningEffort, 'off')

  // 5) 模型元数据查询失败时原样放行，不抛错。
  const broken = fakeHost({ resolveModelInfo: async () => { throw new Error('boom') } })
  apply(broken.ctx, { mode: 'auto', log: true })
  await broken.waterfall(frozenRequest(heavy))
  assert.equal(broken.dispatched[0].reasoningEffort, undefined, '查询失败必须原样放行')
  assert.ok(broken.logs.some((line) => line.includes('unchanged')), `日志里应能看到 unchanged：${broken.logs.join(' | ')}`)

  // 6) 关闭档：直接放行，不做任何判定。
  const offHost = fakeHost({ resolveModelInfo: async () => ({}) })
  apply(offHost.ctx, { mode: 'off', log: true })
  await offHost.waterfall(frozenRequest('你好'))
  assert.equal(offHost.dispatched[0].reasoningEffort, undefined)

  // 7) 选择器与适配器分道：请求头记录 Auto，适配器只接受真实档位。
  const seenEfforts = []
  const host2 = fakeHost({
    resolveModelInfo: async () => ({ reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'off' } }),
  })
  // 一个"像真适配器"的 llm：收到未知档位就报错的实现方式，就是用流里的校验。
  host2.services.llm.stream = (options) => {
    seenEfforts.push(options.reasoningEffort)
    if (options.reasoningEffort !== undefined && !['off', 'low', 'high', 'max'].includes(options.reasoningEffort)) {
      throw new Error(`adapter rejected reasoning effort ${options.reasoningEffort}`)
    }
    return (async function* chunks() {
      yield { type: 'finish', kind: 'completed' }
    })()
  }
  apply(host2.ctx, { mode: 'auto', log: false })
  const autoRequest = Object.freeze({ provider: 'deepseek', model: 'deepseek-flash', sessionId: 's-auto', reasoningEffort: 'auto', messages: Object.freeze([Object.freeze({ role: 'user', content: '你好' })]) })
  const autoChunks = await host2.waterfall(autoRequest)
  assert.deepEqual(autoChunks, ['finish'])
  assert.equal(autoRequest.reasoningEffort, 'auto', '请求对象必须保留 Auto（界面靠它回显）')
  assert.equal(seenEfforts[0], 'off', '适配器拿到的是判定值，不是 auto')

  host2.services.llm.prepareCall = async (callConfig) => ({
    model: { id: callConfig.model },
    config: { provider: callConfig.provider, model: callConfig.model },
    stream: () => (async function* chunks() { yield { type: 'finish', kind: 'completed' } })(),
  })
  apply(host2.ctx, { mode: 'auto', log: false })
  const prepared = await host2.ctx.get('llm').prepareCall({ provider: 'deepseek', model: 'deepseek-flash', sessionId: 's-auto', reasoningEffort: 'auto' })
  assert.equal(prepared.config.reasoningEffort, 'auto', '请求头记录必须留着 Auto')

  // 8) HTTP 端点：GET 报状态，POST 改档位，非法方法 405。
  const route = host.routes.find((entry) => entry.path === ROUTE_PATH)
  assert.ok(route !== undefined, `应注册 ${ROUTE_PATH}`)
  const responses = []
  const makeRes = () => ({
    writeHead(status, headers) {
      responses.push({ status, headers })
    },
    end(body) {
      responses[responses.length - 1].body = JSON.parse(body.toString('utf8'))
    },
  })
  await route.handler({ method: 'GET' }, makeRes())
  assert.equal(responses[0].status, 200)
  assert.equal(responses[0].body.mode, 'auto')
  assert.equal(responses[0].body.stats.applied >= 1, true)
  await route.handler({ method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ mode: 'pin' })) } }, makeRes())
  assert.equal(responses[1].body.mode, 'pin')
  await route.handler({ method: 'DELETE' }, makeRes())
  assert.equal(responses[2].status, 405)
  await route.handler({ method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('{ not json') } }, makeRes())
  assert.equal(responses[3].status, 400)

  // 诊断查询：模型选择器读的就是这份推理等级列表，Auto 必须在里面。
  await route.handler({ method: 'GET', url: '/dsh-auto-effort?catalog=deepseek/deepseek-flash' }, makeRes())
  const probed = responses[4].body
  assert.equal(probed.error, undefined, `catalog probe failed: ${JSON.stringify(probed)}`)
  assert.ok(probed.efforts.some((level) => level.id === 'auto'), `Auto 必须在推理等级列表里：${JSON.stringify(probed.efforts)}`)

  console.log('host wiring OK')
  console.log(host.logs.filter((line) => line.startsWith('auto-effort:')).join('\n'))
} finally {
  await rm(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
}
