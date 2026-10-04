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


/**
 * 直接问一次插件路由并取回 JSON。
 *
 * @param {object} entry - `webServer.register` 收到的路由。
 * @param {string} url - 带查询串的路径。
 * @returns {Promise<object>} 响应体。
 */
async function drain(stream) {
  for await (const _chunk of stream) {
    // 排干即可：这里只关心适配器收到什么。
  }
}

async function readRoute(entry, url) {
  const collected = []
  await entry.handler({ method: 'GET', url }, {
    writeHead() {},
    end(body) {
      collected.push(JSON.parse(body.toString('utf8')))
    },
  })
  return collected[collected.length - 1]
}

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
  // 模型切换列表**不该**出现虚拟档位：开关在插件自己的"优化"面板里。
  assert.equal(probed.efforts.some((level) => level.id === 'auto'), false,
    `模型目录不该出现 auto：${JSON.stringify(probed.efforts)}`)
  assert.ok(probed.efforts.length >= 4, '模型真正的等级要原样保留')

  // --- armed：浏览器选中 auto 后，判定必须接管（宿主落盘那一步实测不可靠）---
  const postArmed = async (body) => {
    const request = (async function* chunks() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    })()
    request.method = 'POST'
    request.url = ROUTE_PATH
    const out = []
    await route.handler(request, { writeHead(status) { out.push(status) }, end(payload) { out.push(payload.toString('utf8')) } })
    return out
  }
  const statusBefore = await postArmed({ auto: true })
  assert.equal(statusBefore[0], 200, 'POST {auto:true} 必须 200')
  assert.match(String(statusBefore[1]), /"auto":true/, 'POST 必须回报 armed=true')

  /** 跑一次请求并取适配器收到的档位（host.dispatched 记录的就是重入后的 options）。 */
  const adapterEffort = async (options) => {
    const before = host.dispatched.length
    await host.waterfall({ ...options, sessionId: `armed-${Math.random().toString(36).slice(2)}` })
    const entry = host.dispatched[before]
    return entry === undefined ? undefined : entry.reasoningEffort
  }

  assert.equal(await adapterEffort({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'max', messages: [{ role: 'user', content: '你好' }] }), 'off',
    'armed 时请求带的 max 必须交给判定（问候→off）')
  assert.equal(await adapterEffort({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'max', messages: [{ role: 'user', content: '全面审查这 8 个模块，必须零错误，不能遗漏任何一处。第一步建清单，第二步核对，第三步修复。' }] }), 'max',
    'armed 时重活仍应到 max')

  const statusOff = await postArmed({ auto: false })
  assert.match(String(statusOff[1]), /"auto":false/, 'POST {auto:false} 必须回报 armed=false')
  assert.equal(await adapterEffort({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'max', messages: [{ role: 'user', content: '你好' }] }), 'max',
    '取消 armed 后手选值必须原样保留')

  console.log('host wiring OK')
  console.log(host.logs.filter((line) => line.startsWith('auto-effort:')).join('\n'))
  // 7b) 关键行为：选 auto 时判定接管；选真实档位（high）时一个字节都不改。
  //     用同一个实例既发请求又读流水——流水是每个插件实例自己的环形缓冲。
  const seenEffort = []
  const host3 = fakeHost({
    resolveModelInfo: async () => ({ reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'off' } }),
  })
  host3.services.llm.stream = (options) => {
    seenEffort.push(options.reasoningEffort ?? null)
    return (async function* chunks() {
      yield { type: 'finish', kind: 'completed' }
    })()
  }
  apply(host3.ctx, { mode: 'auto', log: false })
  const autoReq = Object.freeze({ provider: 'deepseek', model: 'deepseek-flash', sessionId: 's1', reasoningEffort: 'auto', messages: Object.freeze([Object.freeze({ role: 'user', content: '你好' })]) })
  const manualReq = Object.freeze({ provider: 'deepseek', model: 'deepseek-flash', sessionId: 's2', reasoningEffort: 'high', messages: Object.freeze([Object.freeze({ role: 'user', content: '你好' })]) })
  await host3.waterfall(autoReq)
  await host3.waterfall(manualReq)

  assert.equal(autoReq.reasoningEffort, 'auto', '选 auto 时请求对象必须原样保留 auto（界面靠它回显）')
  assert.equal(seenEffort[0], 'off', `选 auto 时必须由判定接管（实际 ${seenEffort[0]}）`)
  assert.equal(seenEffort[1], 'high', `选 high 时必须原样下发（实际 ${seenEffort[1]}）`)

  const route3 = host3.routes.find((entry) => entry.path === ROUTE_PATH)
  const decisions = (await readRoute(route3, '/dsh-auto-effort?decisions=1')).decisions
  const autoRow = decisions.find((row) => row.chosen === 'auto')
  const manualRow = decisions.find((row) => row.chosen === 'high')
  assert.ok(autoRow !== undefined && autoRow.action === 'applied', `auto 应记为 applied：${JSON.stringify(autoRow)}`)
  // 手选值是"明确指令"：判定要么直接让位（pinned），要么算出来正好等于它（unchanged）。
  assert.ok(
    manualRow !== undefined && (manualRow.action === 'pinned' || manualRow.action === 'unchanged'),
    `high 必须让位或原样：${JSON.stringify(manualRow)}`,
  )
  assert.equal(manualRow.effort, 'high', `high 必须保持不变（实际 ${manualRow.effort}）`)

} finally {
  await rm(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
}
