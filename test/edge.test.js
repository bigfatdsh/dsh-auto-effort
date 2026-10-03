/**
 * dsh-auto-effort —— 边界与模糊测试（对抗式检查）。
 *
 * 这一组不问"功能对不对"，只问"会不会炸、会不会静默做错"。两类手段：
 *
 * 1. **模糊测试**：随机消息、随机选项、随机钩子组合，断言不抛错、返回值仍在契约内、
 *    并且"绝不能越界"的几条硬规则（适配器永不见 `auto`；手选真实档位永不被降）成立。
 * 2. **装配测试**：在假宿主上真的 `apply` 一次，验证缓存/上限/多会话/关闭档位等
 *    只有跑起来才会暴露的分支。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ROUTE_PATH,
  apply,
  isVirtualEffort,
  throughAuto,
  withAutoEffort,
  withoutVirtualEffort,
} from '../lib/index.js'
import { applyTier, decideRequest } from '../lib/request.js'
import { CLASSIFY_BUDGET_CHARS, classify, clampEffort, normalizeEfforts } from '../lib/classify.js'

const LEVELS = ['off', 'low', 'high', 'max']

/**
 * 假宿主：只实现插件真正用到的那部分 `llm` 服务。
 *
 * @param {object} [options] - `{ defaultEffort }`。
 * @returns {object} 宿主句柄。
 */
function fakeHost(options = {}) {
  const state = { efforts: [...LEVELS], defaultEffort: options.defaultEffort ?? 'off' }
  /** 适配器那一侧真正收到的请求。记录点必须在**原方法内部**：插件在装配时捕获原方法，
   * 事后替换 `ctx.llm.stream` 收不到任何东西。 */
  const adapterCalls = []
  const listeners = []
  const routes = []
  const logs = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const llm = {
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: state.efforts.map((id) => ({ id, name: id })), defaultEffort: state.defaultEffort },
    }),
    prepareCall: async (callConfig) => ({
      model: { id: callConfig.model },
      config: { ...callConfig },
      adapterDefaults: { reasoningEffort: callConfig.reasoningEffort === undefined },
      stream: (request) => {
        adapterCalls.push({ where: 'preparedStream', effort: request.reasoningEffort })
        return (async function* chunks() {
          yield { type: 'finish', kind: 'completed' }
        })()
      },
    }),
    resolveCallConfig: async (callConfig) => ({ ...callConfig }),
    stream: (request) => {
      adapterCalls.push({ where: 'hostStream', effort: request.reasoningEffort })
      return (async function* chunks() {
        yield { type: 'finish', kind: 'completed' }
      })()
    },
  }
  services.llm = llm

  const ctx = {
    get: (key) => services[key],
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(`WARN ${message}`) },
  }

  /** 按 Cordis 语义跑一遍瀑布。 */
  const waterfall = async (request) => {
    const queue = listeners.filter((entry) => entry.event === 'llm/stream').map((entry) => entry.listener)
    const next = () => (queue.shift() ?? (() => llm.stream(request)))(request, next)
    const stream = next()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk.type)
    return chunks
  }

  const route = () => routes.find((entry) => entry.path === ROUTE_PATH)

  /** 读一次插件端点。 */
  const read = async (url = ROUTE_PATH) => {
    const collected = []
    await route().handler({ method: 'GET', url }, {
      writeHead() {},
      end(body) {
        collected.push(JSON.parse(body.toString('utf8')))
      },
    })
    return collected[collected.length - 1]
  }

  return { ctx, llm, services, adapterCalls, logs, routes, waterfall, route, read, state }
}

/**
 * 一条请求。
 *
 * @param {string} text - 用户文本。
 * @param {object} [extra] - 附加字段。
 * @returns {object} 冻结的请求。
 */
function request(text, extra = {}) {
  return Object.freeze({
    provider: 'deepseek',
    model: 'deepseek-flash',
    messages: Object.freeze([Object.freeze({ role: 'user', content: text })]),
    ...extra,
  })
}

/** 一份最小可用的 state home，避免写到真实 `~/.dsh`。 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'auto-effort-edge-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 装配：假宿主上真的 apply
// ---------------------------------------------------------------------------

test('装配：选 auto 由判定接管、选 high 原样下发，请求对象一个字节不改', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })

    const auto = request('你好', { sessionId: 's-auto', reasoningEffort: 'auto' })
    const manual = request('你好', { sessionId: 's-manual', reasoningEffort: 'high' })
    await host.waterfall(auto)
    await host.waterfall(manual)

    assert.equal(auto.reasoningEffort, 'auto', '请求对象必须保留 auto')
    assert.equal(manual.reasoningEffort, 'high', '请求对象必须保留手选值')
    const hostStreams = host.adapterCalls.filter((row) => row.where === 'hostStream')
    assert.equal(hostStreams[0].effort, 'off', 'auto → 判定值 off')
    assert.equal(hostStreams[1].effort, 'high', 'high → 原样 high')
  })
})

test('装配：手选的四个真实档位，一个都不许被降', async () => {
  await withTempHome(async () => {
    for (const level of LEVELS) {
      const host = fakeHost({ defaultEffort: 'off' })
      apply(host.ctx, { mode: 'auto', log: false })
      // 用最容易被判低的输入去撞它
      await host.waterfall(request('你好', { sessionId: `s-${level}`, reasoningEffort: level }))
      const seen = host.adapterCalls.find((row) => row.where === 'hostStream')
      assert.equal(seen.effort, level, `手选 ${level} 被改成了 ${seen.effort}`)
    }
  })
})

test('装配：model adapter 永不见 auto（四条出站入口都要挡住）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    const auto = request('你好', { sessionId: 's1', reasoningEffort: 'auto' })
    await host.waterfall(auto)
    const prepared = await host.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash', sessionId: 's1', reasoningEffort: 'auto' })
    assert.equal(prepared.config.reasoningEffort, 'auto', '记录侧保留 auto')
    await prepared.stream({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'auto' })
    const resolved = await host.llm.resolveCallConfig({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'auto' })
    assert.notEqual(resolved.reasoningEffort, 'auto', '适配器侧不能看到 auto')
    assert.equal(host.adapterCalls.some((row) => row.effort === 'auto'), false, `适配器见到了 auto：${JSON.stringify(host.adapterCalls)}`)
  })
})

test('装配：目录里追加 Auto 只做一次，且不改模型自带等级', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    const first = await host.llm.resolveModelInfo('deepseek', 'deepseek-flash')
    const second = await host.llm.resolveModelInfo('deepseek', 'deepseek-flash')
    assert.deepEqual(first.reasoning.efforts.map((e) => e.id), [...LEVELS, 'auto'])
    assert.deepEqual(second.reasoning.efforts.map((e) => e.id), [...LEVELS, 'auto'], '重复调用不应重复追加')
    assert.equal(first.reasoning.defaultEffort, 'off', '默认档位不被改动')
  })
})

test('装配：模型没有推理能力时不追加 Auto', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    host.llm.resolveModelInfo = async () => ({ provider: 'deepseek', id: 'plain', name: 'plain' })
    apply(host.ctx, { mode: 'auto', log: false })
    const info = await host.llm.resolveModelInfo('deepseek', 'plain')
    assert.equal(info.reasoning, undefined)
  })
})

test('回归：decision 为 null 的动作（关闭档位）不得抛错', async () => {
  await withTempHome(async () => {
    for (const mode of ['off', 'auto']) {
      const host = fakeHost({ defaultEffort: 'off' })
      apply(host.ctx, { mode, log: false })
      // 带 sessionId：早先"记上一轮档位"的代码在 decision 为 null 时会崩
      await host.waterfall(request('你好', { sessionId: 's1' }))
      if (mode === 'off') {
        assert.equal((await host.read()).enabled, false)
      }
    }
    // disabled / foreign / error 三条路径都不该炸
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'off', log: false })
    await host.waterfall(request('你好', { sessionId: 's2', purpose: 'session-title' }))
    await host.waterfall(request('你好', { sessionId: 's3' }))
  })
})

test('装配：关闭档位（mode=off）时不改档位，但虚拟档位仍被翻译掉', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'off', log: false })
    const auto = request('你好', { sessionId: 's1', reasoningEffort: 'auto' })
    await host.waterfall(auto)
    const seen = host.adapterCalls.find((row) => row.where === 'hostStream')
    // 关键：`auto` 不是模型能力，任何开关状态下都不能落到适配器上。
    // 关闭档位时没有判定值可替，于是翻译成"没带档位"（模型默认）。
    assert.equal(seen.effort, undefined, `关闭档位时适配器收到了 ${seen.effort}`)
    assert.equal((await host.read()).enabled, false)

    // 手选的真实档位在关闭档位时原样保留
    await host.waterfall(request('你好', { sessionId: 's2', reasoningEffort: 'max' }))
    const manual = host.adapterCalls.filter((row) => row.where === 'hostStream').at(-1)
    assert.equal(manual.effort, 'max')
  })
})

test('装配：多会话各自记住自己的档位，互不串味', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    // 复杂任务 → 记 max/high；简单问候 → 记 off
    await host.waterfall(request('全面审查这 8 个模块，必须零错误，不能遗漏任何一处。第一步建清单，第二步核对，第三步修复。', { sessionId: 'heavy' }))
    await host.waterfall(request('你好', { sessionId: 'light' }))

    // 续跑请求（末尾是工具结果）：必须各自继承自己会话的档位
    const continuation = (sessionId) =>
      Object.freeze({
        provider: 'deepseek',
        model: 'deepseek-flash',
        sessionId,
        reasoningEffort: 'auto',
        messages: Object.freeze([
          Object.freeze({ role: 'user', content: '帮我改这个函数' }),
          Object.freeze({ role: 'tool', content: 'done', toolCallId: 'c1' }),
        ]),
      })
    await host.waterfall(continuation('heavy'))
    await host.waterfall(continuation('light'))
    const efforts = host.adapterCalls.filter((row) => row.where === 'hostStream').map((row) => row.effort)
    assert.equal(efforts.length, 4)
    assert.notEqual(efforts[2], efforts[3], `两个会话的续跑档位串味了：${JSON.stringify(efforts)}`)
    assert.equal(efforts[3], 'off', `轻会话的续跑应继承 off，实际 ${efforts[3]}`)
  })
})

test('装配：解析模型元数据抛错时不打断请求', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    host.llm.resolveModelInfo = async () => {
      throw new Error('boom')
    }
    apply(host.ctx, { mode: 'auto', log: false })
    const chunks = await host.waterfall(request('帮我修一下这个报错', { sessionId: 's1' }))
    assert.deepEqual(chunks, ['finish'])
    const seen = host.adapterCalls.find((row) => row.where === 'hostStream')
    assert.equal(seen.effort, undefined, '查询失败必须原样放行（适配器看到"没带档位"）')
  })
})

test('装配：决策流水记录 chosen 与 effort，供"生效/不生效"核对', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    await host.waterfall(request('你好', { sessionId: 's1', reasoningEffort: 'auto' }))
    await host.waterfall(request('你好', { sessionId: 's2', reasoningEffort: 'high' }))
    const decisions = (await host.read(`${ROUTE_PATH}?decisions=1`)).decisions
    const autoRow = decisions.find((row) => row.chosen === 'auto')
    const highRow = decisions.find((row) => row.chosen === 'high')
    assert.equal(autoRow.action, 'applied')
    assert.equal(autoRow.effort, 'off')
    assert.equal(highRow.effort, 'high')
    assert.ok(['pinned', 'unchanged'].includes(highRow.action), `high 的动作：${highRow.action}`)
  })
})

test('装配：日志开关真的控制输出', async () => {
  await withTempHome(async () => {
    const quiet = fakeHost({ defaultEffort: 'off' })
    apply(quiet.ctx, { mode: 'auto', log: false })
    await quiet.waterfall(request('你好', { sessionId: 's1' }))
    assert.equal(quiet.logs.filter((line) => line.startsWith('auto-effort:')).length, 0)

    const loud = fakeHost({ defaultEffort: 'off' })
    apply(loud.ctx, { mode: 'auto', log: true })
    await loud.waterfall(request('你好', { sessionId: 's1' }))
    assert.equal(loud.logs.filter((line) => line.startsWith('auto-effort:')).length, 1)
  })
})

// ---------------------------------------------------------------------------
// 纯函数边界
// ---------------------------------------------------------------------------

test('withoutVirtualEffort：畸形输入一律原样返回，不抛错', () => {
  const config = { effortId: 'auto' }
  for (const value of [null, undefined, 42, 'x', [], {}]) {
    assert.doesNotThrow(() => withoutVirtualEffort(value, config, () => undefined))
  }
  assert.equal(withoutVirtualEffort(null, config), null)
  assert.equal(withoutVirtualEffort({ provider: 'p' }, config).provider, 'p')
})

test('withoutVirtualEffort：会话记忆为空集合时，只摘键、不编值', () => {
  const config = { effortId: 'auto' }
  const request1 = { provider: 'p', model: 'm', sessionId: 's', reasoningEffort: 'auto' }
  const stripped = withoutVirtualEffort(request1, config, () => undefined)
  assert.equal(Object.hasOwn(stripped, 'reasoningEffort'), false)
  assert.equal(request1.reasoningEffort, 'auto', '原对象不动')
})

test('throughAuto：结果没有 config / stream 时也不抛错', () => {
  const config = { effortId: 'auto' }
  assert.deepEqual(throughAuto({ model: { id: 'm' } }, { reasoningEffort: 'auto' }, config), { model: { id: 'm' } })
  assert.equal(throughAuto(null, {}, config), null)
  const withConfig = throughAuto({ config: { provider: 'p' } }, { reasoningEffort: 'auto' }, config)
  assert.equal(withConfig.config.reasoningEffort, 'auto')
})

test('isVirtualEffort：只认完全相等的虚拟档位', () => {
  const config = { effortId: 'auto' }
  assert.equal(isVirtualEffort({ reasoningEffort: 'auto' }, config), true)
  assert.equal(isVirtualEffort({ reasoningEffort: 'Auto' }, config), false)
  assert.equal(isVirtualEffort({ reasoningEffort: 'high' }, config), false)
  assert.equal(isVirtualEffort(null, config), false)
})

test('withAutoEffort：模型自带 auto 时不重复追加；未知 defaultEffort 不越界', () => {
  const config = { effortId: 'auto', effortName: 'Auto', effortDescription: 'x', autoDefault: true }
  const already = { reasoning: { efforts: [{ id: 'auto', name: 'Auto' }], defaultEffort: 'auto' } }
  assert.equal(withAutoEffort(already, config), already)
  const plain = { reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
  assert.equal(withAutoEffort(plain, config).reasoning.defaultEffort, 'auto')
})

test('applyTier：缺失或畸形策略按默认边界处理', () => {
  assert.equal(applyTier('max', undefined).tier, 'max')
  assert.equal(applyTier('off', {}).tier, 'off')
  assert.equal(applyTier('bogus', undefined).tier, 'high')
  assert.equal(applyTier('max', { maxTier: 5 }).tier, 'max')
})

test('clampEffort：畸形能力表一并不抛错', () => {
  for (const efforts of [null, undefined, [], [null], [{}], ['x'], [{ id: 5 }]]) {
    assert.doesNotThrow(() => clampEffort({ tier: 'high', efforts }))
  }
  assert.equal(clampEffort({ tier: 'high', efforts: null }), undefined)
  assert.equal(normalizeEfforts([null, {}, { id: '' }, { id: 'a' }]).join(','), 'a')
})

test('decideRequest：policy 缺失时用默认边界', async () => {
  const options = request('你好')
  const outcome = await decideRequest({ options, mode: 'auto', policy: undefined, resolveModelInfo: async () => ({ reasoning: { efforts: LEVELS, defaultEffort: 'off' } }) })
  assert.ok(['applied', 'unchanged'].includes(outcome.action))
})

test('decideRequest：options 是冻结对象时也要能改写结果而不改原对象', async () => {
  const options = Object.freeze(request('全面审查这 8 个模块，必须零错误，不能遗漏任何一处。第一步建清单，第二步核对，第三步修复。'))
  const outcome = await decideRequest({
    options,
    mode: 'auto',
    policy: { minTier: 'off', maxTier: 'max', effortFloor: 'observed', effortCeiling: 'max', effortId: 'auto' },
    resolveModelInfo: async () => ({ reasoning: { efforts: LEVELS, defaultEffort: 'off' } }),
  })
  assert.equal(outcome.action, 'applied')
  assert.notEqual(outcome.options, options)
  assert.equal(Object.hasOwn(options, 'reasoningEffort'), false)
})

// ---------------------------------------------------------------------------
// 模糊测试
// ---------------------------------------------------------------------------

/**
 * 可复现的伪随机数（避免测试偶发）。
 *
 * @param {number} seed - 种子。
 * @returns {() => number} `[0,1)` 随机数。
 */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const ALPHABET = [
  '你好', 'hello', '帮我', '把', '转成', '报错', 'bug', '必须', '全部', '重构', '```', 'https://x.y/z',
  '/tmp/a.js', '第一步', '另外', '？', '?!', '。', '   ', '\n', '\t', '审计', '性能', '部署', '测试',
  '\u0000', '\\', '"', "'", '${x}', '<script>', '中文'.repeat(5), 'a'.repeat(40), '😀', 'e\u0301',
]

test('模糊：5000 条随机消息，classify 永不抛错且输出在契约内', () => {
  const random = rng(20261003)
  for (let i = 0; i < 5000; i += 1) {
    const parts = []
    const count = 1 + Math.floor(random() * 60)
    for (let k = 0; k < count; k += 1) parts.push(ALPHABET[Math.floor(random() * ALPHABET.length)])
    const text = parts.join(random() < 0.5 ? '' : ' ')
    const toolCount = Math.floor(random() * 60)
    const decision = classify({ messages: [{ role: 'user', content: text }], toolCount })
    assert.ok(decision.tier === null || LEVELS.includes(decision.tier), `tier=${decision.tier}`)
    assert.equal(typeof decision.score, 'number')
    assert.ok(Number.isFinite(decision.score), `score=${decision.score}`)
    assert.ok(Array.isArray(decision.signals))
    assert.equal(decision.toolLoop, false)
    assert.equal(Object.isFrozen(decision), false)
  }
})

test('模糊：超长输入不炸、不随长度线性变慢（扫描窗口有上限）', () => {
  const huge = '你好'.repeat(200_000) // 40 万字符
  const started = Date.now()
  const decision = classify({ messages: [{ role: 'user', content: huge }], toolCount: 30 })
  const elapsed = Date.now() - started
  assert.ok(LEVELS.includes(decision.tier))
  assert.ok(elapsed < 500, `40 万字符耗时 ${elapsed}ms，超过预算`)
  assert.ok(decision.words > 0)
  assert.ok(CLASSIFY_BUDGET_CHARS > 0)
})

test('模糊：随机 JSON 形状的消息数组不抛错', () => {
  const random = rng(7)
  const shape = () => {
    const pick = Math.floor(random() * 8)
    if (pick === 0) return null
    if (pick === 1) return 'string'
    if (pick === 2) return 42
    if (pick === 3) return []
    if (pick === 4) return { role: 'user' }
    if (pick === 5) return { role: 'user', content: null }
    if (pick === 6) return { role: 'tool', isError: true }
    return { role: 'user', content: [{}, { text: 5 }, 'x'] }
  }
  for (let i = 0; i < 2000; i += 1) {
    const length = Math.floor(random() * 6)
    const messages = Array.from({ length }, shape)
    assert.doesNotThrow(() => classify({ messages, toolCount: random() * 100 }))
  }
})

test('模糊：decideRequest 在随机选项下不抛错，且绝不把 auto 交给适配器', async () => {
  const random = rng(99)
  const efforts = [...LEVELS, 'auto']
  for (let i = 0; i < 400; i += 1) {
    const options = {
      provider: random() < 0.1 ? undefined : 'deepseek',
      model: random() < 0.1 ? undefined : 'deepseek-flash',
      sessionId: `s${i % 5}`,
      ...(random() < 0.7 ? { reasoningEffort: efforts[Math.floor(random() * efforts.length)] } : {}),
      ...(random() < 0.1 ? { purpose: 'session-title' } : {}),
      messages: random() < 0.1 ? [] : [{ role: 'user', content: `随机 ${i} 帮我修一下报错` }],
    }
    const policy = {
      minTier: LEVELS[Math.floor(random() * LEVELS.length)],
      maxTier: LEVELS[Math.floor(random() * LEVELS.length)],
      effortFloor: ['off', 'observed', 'adapter-default'][Math.floor(random() * 3)],
      effortCeiling: ['max', 'off', 'low', 'high'][Math.floor(random() * 4)],
      effortId: 'auto',
    }
    const outcome = await decideRequest({
      options,
      mode: ['auto', 'pin', 'off'][Math.floor(random() * 3)],
      policy,
      resolveModelInfo: async () => ({ reasoning: { efforts: LEVELS, defaultEffort: LEVELS[Math.floor(random() * LEVELS.length)] } }),
    })
    assert.equal(typeof outcome.action, 'string')
    if (outcome.options?.reasoningEffort !== undefined && outcome.options.reasoningEffort !== options.reasoningEffort) {
      assert.notEqual(outcome.options.reasoningEffort, 'auto', '改写结果不能是虚拟档位')
    }
  }
})

// ---------------------------------------------------------------------------
// DOM 观察者稳定性（自己改 DOM 不能把自己再触发成循环）
// ---------------------------------------------------------------------------

/**
 * 造一个最小但真实的模型选择器 DOM：触发器 + 等级菜单。
 *
 * @returns {object} 句柄。
 */
function pickerDom() {
  const listeners = []
  let observers = 0
  let callback = null
  let triggerMark = null
  let effortText = 'high'
  const BASE = 'option'
  const SEL = 'selected'
  const textNode = { nodeType: 3, nodeValue: effortText }
  const effort = {
    get textContent() {
      return textNode.nodeValue
    },
    set textContent(value) {
      textNode.nodeValue = value
    },
  }
  effort.ownerDocument = {
    createTreeWalker: () => {
      let done = false
      return { nextNode: () => (done ? null : ((done = true), textNode)) }
    },
  }
  const trigger = {
    getAttribute: (n) => (n === 'data-dsh-auto-effort' ? triggerMark : null),
    setAttribute: (n, v) => {
      if (n === 'data-dsh-auto-effort') triggerMark = v
    },
    removeAttribute: () => {
      triggerMark = null
    },
    querySelector: () => effort,
  }
  const mkOption = (text, selected) => {
    let cls = selected ? `${BASE} ${SEL}` : BASE
    let checked = selected ? 'true' : 'false'
    return {
      get textContent() {
        return text
      },
      get className() {
        return cls
      },
      set className(v) {
        cls = v
      },
      getAttribute: (n) => (n === 'aria-checked' ? checked : null),
      setAttribute: (n, v) => {
        if (n === 'aria-checked') checked = v
      },
      querySelectorAll: () => [{ textContent: text }],
    }
  }
  const auto = mkOption('Auto', false)
  const high = mkOption('High', true)
  const document = {
    body: {},
    head: { append: () => {} },
    createElement: () => ({ id: '', textContent: '' }),
    getElementById: () => null,
    querySelectorAll: (selector) => {
      if (selector === '[class*="_trigger"]') return [trigger]
      if (selector === '[role="menuitemradio"]') return [high, auto]
      return []
    },
    querySelector: (selector) => (selector === '[class*="_trigger"]' ? { textContent: `m · ${effort.textContent}` } : null),
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: () => {},
  }
  globalThis.document = document
  globalThis.localStorage = { getItem: () => null, setItem: () => {} }
  globalThis.MutationObserver = class {
    constructor(fn) {
      callback = fn
      observers += 1
    }
    observe() {}
    disconnect() {}
  }
  return {
    document,
    nodes: { auto, high },
    click: (node) => {
      for (const entry of listeners) if (entry.type === 'click') entry.fn({ target: node })
    },
    mark: () => triggerMark,
    effortText: () => effort.textContent,
    /** 模拟宿主重渲染若干次；返回总回调次数，用于发现自激循环。 */
    churn: (times) => {
      let calls = 0
      for (let i = 0; i < times; i += 1) {
        calls += 1
        callback?.()
      }
      return { calls, observers }
    },
  }
}

test('DOM 稳定性：点 Auto 后连续触发观察者 200 次，状态收敛且不自激', async () => {
  const dom = pickerDom()
  let counter = 0
  let registration
  globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } }
  await import(`../lib/client.js?stability=${++counter}`)
  const cleanups = []
  const cells = []
  let cursor = 0
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
      if (!(index in cells)) {
        cells[index] = get()
        subscribe(() => {
          cells[index] = get()
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
  const slots = []
  exports.apply({
    effect: (fn) => {
      fn()
      return () => {}
    },
    slots: { inject: (_target, register) => register(), register: (_options, component) => slots.push(component) },
  })
  const render = () => {
    cursor = 0
    while (cleanups.length > 0) cleanups.pop()()
    slots[0]()
  }
  render()

  dom.click(dom.nodes.auto)
  render()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(dom.mark(), '1', '标记应已打开')
  assert.equal(dom.effortText(), 'Auto')
  assert.equal(dom.nodes.auto.getAttribute('aria-checked'), 'true')

  // 连续触发观察者：DOM 已稳定，回调不应再产生新的改动（否则会自激）。
  dom.churn(200)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(dom.mark(), '1')
  assert.equal(dom.effortText(), 'Auto')
  assert.equal(dom.nodes.auto.getAttribute('aria-checked'), 'true')
  assert.equal(dom.nodes.high.getAttribute('aria-checked'), 'false')
})

// ---------------------------------------------------------------------------
// 上下文继承：装配层（会话记忆是否真的接上）
// ---------------------------------------------------------------------------

test('装配：任务进行中时，含糊短追问按上一轮档位走；新会话不继承', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    const effortSeen = () => host.adapterCalls.filter((row) => row.where === 'hostStream').at(-1)?.effort

    // 第一轮：重活 → max
    await host.waterfall(request('审计这 12 个模块的架构、安全、性能，逐条给根因与修复，必须详尽完整，另外还要给出回归测试与上线清单', { sessionId: 'work' }))
    assert.equal(effortSeen(), 'max')

    // 第二轮：含糊短追问 → 继承 max（而不是掉到 low）
    await host.waterfall(request('把它改成流式', { sessionId: 'work' }))
    assert.equal(effortSeen(), 'max', '短追问必须继承任务的档位')

    // 第三轮：先来一句闲聊（不清空任务槽位），再说一句含糊短追问 → 仍然继承
    await host.waterfall(request('好的', { sessionId: 'work' }))
    await host.waterfall(request('那块再收一下', { sessionId: 'work' }))
    assert.equal(effortSeen(), 'max', '跨过一句闲聊后仍应继承（任务槽位不被闲聊清空）')

    // 另一条会话同样的话：没有"正在进行的任务"，不继承
    await host.waterfall(request('把它改成流式', { sessionId: 'fresh' }))
    assert.notEqual(effortSeen(), 'max', '新会话不该继承别的会话的档位')

    // 收尾：任务进行中也不该被拉高
    await host.waterfall(request('谢谢', { sessionId: 'work' }))
    assert.equal(effortSeen(), 'off', `收尾应降下来，实际 ${effortSeen()}`)

    const decisions = (await host.read(`${ROUTE_PATH}?decisions=1`)).decisions
    if (!decisions.some((row) => row.inherited === true)) {
      // eslint-disable-next-line no-console -- 失败现场
        console.error('DBG all decisions:', JSON.stringify(decisions))
      console.error('DBG adapterCalls:', JSON.stringify(host.adapterCalls))
    }
    const inherited = decisions.filter((row) => row.inherited === true)
    assert.equal(inherited.length, 2, `应有两次继承：${JSON.stringify(decisions)}`)
    assert.equal(inherited[0].chosen, null)
    assert.equal(inherited[0].tier, 'max')
  })
})

test('装配：续跑请求不更新"上一轮档位"（沿用本任务档位）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    await host.waterfall(request('审计这 12 个模块，必须详尽完整，逐条给根因与修复，另外还要给出回归测试与上线清单', { sessionId: 'w' }))
    // 续跑（末尾是工具结果）不应把档位改成续跑分支的 null
    await host.waterfall(Object.freeze({
      provider: 'deepseek',
      model: 'deepseek-flash',
      sessionId: 'w',
      reasoningEffort: 'auto',
      messages: Object.freeze([
        Object.freeze({ role: 'user', content: '帮我改这个函数' }),
        Object.freeze({ role: 'tool', content: 'done', toolCallId: 'c1' }),
      ]),
    }))
    // 之后再来一句含糊短追问，仍应继承 max
    await host.waterfall(request('这个再快一点', { sessionId: 'w' }))
    const last = host.adapterCalls.filter((row) => row.where === 'hostStream').at(-1)
    assert.equal(last.effort, 'max', `续跑后仍应继承 max，实际 ${last.effort}`)
  })
})

test('装配：任务槽位有窗口——隔了太多条用户消息后不再继承', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    const effortSeen = () => host.adapterCalls.filter((row) => row.where === 'hostStream').at(-1)?.effort

    await host.waterfall(request('审计这 12 个模块的架构、安全、性能，逐条给根因与修复，必须详尽完整，另外还要给出回归测试与上线清单', { sessionId: 'w' }))
    assert.equal(effortSeen(), 'max')
    // 连续 6 条与任务无关的轻消息（各自都判低），把窗口推过去
    for (let i = 0; i < 6; i += 1) await host.waterfall(request('为什么', { sessionId: 'w' }))
    await host.waterfall(request('那块再收一下', { sessionId: 'w' }))
    assert.notEqual(effortSeen(), 'max', `超出窗口后不该再继承，实际 ${effortSeen()}`)
  })
})

test('装配：窗口可配（taskMaxAge 调大后重新继承）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false, taskMaxAge: 10 })
    const effortSeen = () => host.adapterCalls.filter((row) => row.where === 'hostStream').at(-1)?.effort
    await host.waterfall(request('审计这 12 个模块，必须详尽完整，逐条给根因与修复，另外还要给出回归测试与上线清单', { sessionId: 'w' }))
    for (let i = 0; i < 6; i += 1) await host.waterfall(request('为什么', { sessionId: 'w' }))
    await host.waterfall(request('那块再收一下', { sessionId: 'w' }))
    assert.equal(effortSeen(), 'max', `窗口内应继承，实际 ${effortSeen()}`)
  })
})

test('装配：用户转向带锚点的新事情后，旧任务槽位作废', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    const effortSeen = () => host.adapterCalls.filter((row) => row.where === 'hostStream').at(-1)?.effort

    await host.waterfall(request('审计这 12 个模块的架构、安全、性能，逐条给根因与修复，必须详尽完整，另外还要给出回归测试与上线清单', { sessionId: 'w' }))
    assert.equal(effortSeen(), 'max')
    await host.waterfall(request('那块再收一下', { sessionId: 'w' }))
    assert.equal(effortSeen(), 'max', '仍在同一件事上时应继承')

    // 转向：带具体路径的轻消息 → 旧任务作废
    await host.waterfall(request('看一下 /tmp/out.csv', { sessionId: 'w' }))
    await host.waterfall(request('继续', { sessionId: 'w' }))
    assert.notEqual(effortSeen(), 'max', `旧任务应已作废，实际 ${effortSeen()}`)
  })
})

test('装配：闲聊不作废任务槽位（"好的"之后"继续"仍是同一件事）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ defaultEffort: 'off' })
    apply(host.ctx, { mode: 'auto', log: false })
    const effortSeen = () => host.adapterCalls.filter((row) => row.where === 'hostStream').at(-1)?.effort
    await host.waterfall(request('重构整个项目的数据层，要求零错误、不能遗漏任何调用点，先出方案再按步骤执行', { sessionId: 'w' }))
    for (const filler of ['好的', '嗯', '收到']) await host.waterfall(request(filler, { sessionId: 'w' }))
    await host.waterfall(request('继续', { sessionId: 'w' }))
    assert.equal(effortSeen(), 'max', '跨过三句闲聊后仍应继承（槽位不被闲聊清空）')
  })
})
