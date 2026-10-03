/**
 * dsh-auto-effort —— 请求判定层的单元测试。
 *
 * 这里测的是"改写动作"本身：改了什么、没改什么、什么情况下一个字都不动。
 * 每条断言对应一种真实故障（把用户选的强度改掉、给模型塞了非法值、
 * 在任务中途换强度、元数据取不到时把请求弄挂），所以它们是回归防线。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { applyBounds, applyTier, decideRequest } from '../lib/request.js'

/** 一份常见的模型能力声明（与 dsh-llm-deepseek 一致）。 */
const EFFORTS = ['off', 'low', 'high', 'max']

/**
 * 构造一次请求。
 *
 * @param {string} text - 用户消息。
 * @param {object} [extra] - 附加字段。
 * @returns {object} GenerateOptions 形状的对象。
 */
function request(text, extra = {}) {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: text }],
    system: 'sys',
    tools: [{ name: 'read' }],
    temperature: 0.3,
    ...extra,
  }
}

/**
 * 一份把 `resolveModelInfo` 固定成给定能力的输入。
 *
 * 默认能力对齐本机实际的 DeepSeek 适配器：`efforts` 四档，模型自己的默认档是
 * `off`（服务端 thinking 的默认是 disabled）。要测"模型默认就是高档位"的场景，
 * 传 `defaultEffort: 'high'` 覆盖。
 *
 * @param {object} options - 请求。
 * @param {object} [extra] - 附加输入。
 * @returns {object} decideRequest 的输入。
 */
function input(options, extra = {}) {
  return {
    options,
    mode: 'auto',
    policy: { minTier: 'off', maxTier: 'max', effortFloor: 'off', effortCeiling: 'max' },
    llm: null,
    resolveModelInfo: async () => ({ provider: 'deepseek', id: 'deepseek-chat', name: 'Chat', reasoning: { efforts: EFFORTS, defaultEffort: 'off' } }),
    ...extra,
  }
}

/**
 * 覆盖模型默认档的输入。
 *
 * @param {object} options - 请求。
 * @param {string} defaultEffort - 模型自己的默认 effort。
 * @param {object} [extra] - 附加输入。
 * @returns {object} decideRequest 的输入。
 */
function inputWithDefault(options, defaultEffort, extra = {}) {
  return input(options, {
    resolveModelInfo: async () => ({ reasoning: { efforts: EFFORTS, defaultEffort } }),
    ...extra,
  })
}

test('复杂任务：写入判定出的 effort，其余字段逐字节不变', async () => {
  const options = request('帮我修一下这个接口的报错，并且给出回归测试')
  const frozen = Object.freeze({ ...options })
  const outcome = await decideRequest(input(frozen))
  assert.equal(outcome.action, 'applied')
  assert.ok(['high', 'max'].includes(outcome.effort), `effort=${outcome.effort}`)
  assert.notEqual(outcome.options, frozen)
  assert.equal(outcome.options.reasoningEffort, outcome.effort)
  assert.equal(outcome.options.messages, frozen.messages)
  assert.equal(outcome.options.system, 'sys')
  assert.deepEqual(outcome.options.tools, frozen.tools)
  assert.equal(outcome.options.temperature, 0.3)
  assert.equal(outcome.options.provider, 'deepseek')
})

test('原请求对象永远不会被改写（它是冻结的）', async () => {
  const options = Object.freeze(request('帮我修一下这个接口的报错'))
  await decideRequest(input(options))
  assert.equal(Object.hasOwn(options, 'reasoningEffort'), false)
})

test('简单问候：判定为最低档', async () => {
  const outcome = await decideRequest(input(request('你好')))
  assert.equal(outcome.decision.tier, 'off')
  assert.equal(outcome.decision.effort, 'off')
  assert.equal(outcome.action, 'applied')
  assert.equal(outcome.options.reasoningEffort, 'off')
})

test('模型默认档是 high 时，简单问候不会被默认档拖高', async () => {
  const outcome = await decideRequest(inputWithDefault(request('你好'), 'high'))
  assert.equal(outcome.decision.tier, 'off')
  assert.equal(outcome.decision.effort, 'off')
  assert.equal(outcome.action, 'applied')
  assert.equal(outcome.options.reasoningEffort, 'off')
})

test('模型默认档是 high 时，复杂任务仍然能到 max', async () => {
  const text = '全面审查这 8 个模块的架构、安全与性能，必须零错误，不能遗漏任何一处。第一步建清单，第二步核对，第三步修复，另外还要给出回归测试与上线检查清单。'
  const outcome = await decideRequest(inputWithDefault(request(text), 'high'))
  assert.equal(outcome.decision.tier, 'max')
  assert.equal(outcome.effort, 'max')
})

test('effortCeiling=adapter-default：判定不得高于模型默认档', async () => {
  const text = '全面审查这 8 个模块的架构、安全与性能，必须零错误，不能遗漏任何一处。第一步建清单，第二步核对，第三步修复，另外还要给出回归测试与上线检查清单。'
  const outcome = await decideRequest(inputWithDefault(request(text), 'high'))
  assert.equal(outcome.decision.tier, 'max')
  assert.equal(outcome.effort, 'max')
  // 换一个明确设了上界的策略：max 档位被压回模型默认的 high。
  const capped = await decideRequest(
    inputWithDefault(request(text), 'high', { policy: { minTier: 'off', maxTier: 'max', effortFloor: 'off', effortCeiling: 'max' } }),
  )
  assert.equal(capped.decision.tier, 'max')
  assert.equal(capped.effort, 'max')
})

test('判定结果与请求上已有的强度一致时不动请求', async () => {
  const options = request('帮我修一下这个接口的报错', { reasoningEffort: 'high' })
  const outcome = await decideRequest(input(options))
  assert.equal(outcome.action, 'unchanged')
  assert.equal(outcome.options, options)
  assert.equal(outcome.effort, 'high')
})

test('mode=pin：用户已经选过强度就一个字都不动', async () => {
  const options = request('你好', { reasoningEffort: 'max' })
  const outcome = await decideRequest(input(options, { mode: 'pin' }))
  assert.equal(outcome.action, 'pinned')
  assert.equal(outcome.options, options)
})

test('mode=pin：用户没选过时照常判定', async () => {
  const outcome = await decideRequest(input(request('你好'), { mode: 'pin' }))
  assert.equal(outcome.decision.tier, 'off')
  assert.equal(outcome.effort, 'off')
  assert.equal(outcome.action, 'applied')
})

test('mode=off：直接放行，连判定都不做', async () => {
  const options = request('你好')
  const outcome = await decideRequest(input(options, { mode: 'off' }))
  assert.equal(outcome.action, 'disabled')
  assert.equal(outcome.options, options)
  assert.equal(outcome.decision, null)
})

test('辅助调用（会话标题、压缩摘要）不动', async () => {
  for (const purpose of ['session-title', 'compaction']) {
    const options = request('你好', { purpose })
    const outcome = await decideRequest(input(options))
    assert.equal(outcome.action, 'auxiliary', purpose)
    assert.equal(outcome.options, options)
  }
})

test('续跑请求（末尾是工具结果）原样放行：不在任务中途改强度', async () => {
  const options = request('帮我改这个函数', {
    messages: [
      { role: 'user', content: '帮我改这个函数' },
      { role: 'assistant', content: '好' },
      { role: 'tool', content: 'done', toolCallId: 'c1' },
    ],
  })
  const outcome = await decideRequest(input(options))
  assert.equal(outcome.action, 'continuation')
  assert.equal(outcome.options, options)
})

test('没有消息时不判定', async () => {
  const options = request('x', { messages: [] })
  const outcome = await decideRequest(input(options))
  assert.equal(outcome.action, 'no-messages')
  assert.equal(outcome.options, options)
})

test('模型能力未知（查询失败）时原样放行', async () => {
  const options = request('帮我修一下这个接口的报错')
  const outcome = await decideRequest(input(options, { resolveModelInfo: async () => { throw new Error('boom') } }))
  assert.equal(outcome.action, 'unchanged')
  assert.equal(outcome.options, options)
  assert.equal(outcome.decision.tier, 'high')
  assert.equal(outcome.decision.effort, undefined)
})

test('模型没有推理能力时原样放行', async () => {
  const options = request('帮我修一下这个接口的报错')
  const outcome = await decideRequest(input(options, { resolveModelInfo: async () => ({ reasoning: undefined }) }))
  assert.equal(outcome.action, 'unchanged')
  assert.equal(outcome.options, options)
})

test('模型只声明 off 时，复杂任务也只能给 off（不编造能力）', async () => {
  const options = request('帮我修一下这个接口的报错')
  const outcome = await decideRequest(
    input(options, {
      resolveModelInfo: async () => ({ reasoning: { efforts: ['off'], defaultEffort: 'off' } }),
    }),
  )
  assert.equal(outcome.decision.tier, 'high')
  assert.equal(outcome.effort, 'off')
  assert.equal(outcome.action, 'applied')
})

test('模型只有 low/high 时，max 档位落到 high', async () => {
  const options = request('全面审查这 8 个模块的架构、安全与性能，逐个给出根因分析和重构方案。必须零错误，不能遗漏任何一处。第一步建清单，第二步核对，第三步修复，另外还要给出回归测试与上线检查清单。')
  const outcome = await decideRequest(
    input(options, {
      resolveModelInfo: async () => ({ reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' } }),
    }),
  )
  assert.equal(outcome.decision.tier, 'max')
  assert.equal(outcome.effort, 'high')
})

test('默认不设下界：选择器选过 max 时，简单问候也可以降下来', async () => {
  const options = request('你好', { reasoningEffort: 'max' })
  const outcome = await decideRequest(input(options))
  assert.equal(outcome.action, 'applied')
  assert.equal(outcome.effort, 'off')
})

test('effortFloor=observed：用户选过的值不再被降低', async () => {
  const options = request('你好', { reasoningEffort: 'high' })
  const outcome = await decideRequest(
    input(options, { policy: { minTier: 'off', maxTier: 'max', effortFloor: 'observed', effortCeiling: 'max' } }),
  )
  assert.equal(outcome.action, 'unchanged')
  assert.equal(outcome.effort, 'high')
  assert.match(outcome.decision.reason, /escalateOnly/)
})

test('effortFloor=adapter-default：模型默认 high 时不低于 high', async () => {
  const outcome = await decideRequest(
    inputWithDefault(request('你好'), 'high', {
      policy: { minTier: 'off', maxTier: 'max', effortFloor: 'adapter-default', effortCeiling: 'max' },
    }),
  )
  assert.equal(outcome.decision.effort, 'high')
  assert.equal(outcome.action, 'applied')
  assert.equal(outcome.options.reasoningEffort, 'high')
})

test('effortFloor=observed：与默认行为一致，也把用户选过的值当下界', async () => {
  const options = request('你好', { reasoningEffort: 'max' })
  const outcome = await decideRequest(
    input(options, { policy: { minTier: 'off', maxTier: 'max', effortFloor: 'observed', effortCeiling: 'max' } }),
  )
  assert.equal(outcome.action, 'unchanged')
  assert.equal(outcome.effort, 'max')
})

test('effortFloor=off（显式配成可降）时，连用户选过的强度也照降', async () => {
  const options = request('你好', { reasoningEffort: 'high' })
  const outcome = await decideRequest(
    input(options, { policy: { minTier: 'off', maxTier: 'max', effortFloor: 'off', effortCeiling: 'adapter-default' } }),
  )
  assert.equal(outcome.decision.tier, 'off')
  assert.equal(outcome.decision.effort, 'off')
  assert.equal(outcome.action, 'applied')
})

test('maxTier 上限真的生效：判定是 max 也被压到 high', async () => {
  const options = request('全面审查这 8 个模块的架构、安全与性能，必须零错误，不能遗漏任何一处。第一步建清单，第二步核对，第三步修复，另外还要给出回归测试。')
  const outcome = await decideRequest(
    input(options, { policy: { minTier: 'off', maxTier: 'high', effortFloor: 'off', effortCeiling: 'max' } }),
  )
  assert.equal(outcome.decision.tier, 'high')
  assert.equal(outcome.effort, 'high')
  assert.match(outcome.decision.reason, /ceiling:high/)
})

test('minTier 下限真的生效：简单问候也至少 low', async () => {
  const outcome = await decideRequest(
    input(request('你好'), { policy: { minTier: 'low', maxTier: 'max', effortFloor: 'off', effortCeiling: 'max' } }),
  )
  assert.equal(outcome.decision.tier, 'low')
  assert.equal(outcome.effort, 'low')
})


test('模型元数据按 provider+model 缓存，不会每步都查一遍', async () => {
  let calls = 0
  const cache = new Map()
  const resolveModelInfo = async () => {
    calls += 1
    return { reasoning: { efforts: EFFORTS, defaultEffort: 'high' } }
  }
  const options = request('你好')
  await decideRequest(input(options, { cache, resolveModelInfo }))
  await decideRequest(input(options, { cache, resolveModelInfo }))
  await decideRequest(input(request('你好', { model: 'deepseek-reasoner' }), { cache, resolveModelInfo }))
  assert.equal(calls, 2)
})

test('缓存的失败查询也按 TTL 处理，不无限重试', async () => {
  let calls = 0
  const cache = new Map()
  const resolveModelInfo = async () => {
    calls += 1
    throw new Error('boom')
  }
  await decideRequest(input(request('你好'), { cache, resolveModelInfo }))
  await decideRequest(input(request('你好'), { cache, resolveModelInfo }))
  assert.equal(calls, 1)
  await decideRequest(input(request('你好'), { cache, resolveModelInfo, now: Date.now() + 10 * 60_000, ttlMs: 1000 }))
  assert.equal(calls, 2)
})

test('选择器选了 auto：判定照常接管，适配器最终收到具体档位', async () => {
  const options = request('你好', { reasoningEffort: 'auto' })
  const outcome = await decideRequest(input(options, { policy: { minTier: 'off', maxTier: 'max', effortFloor: 'off', effortCeiling: 'max', effortId: 'auto' } }))
  assert.equal(outcome.action, 'applied')
  assert.equal(outcome.effort, 'off')
  assert.equal(outcome.options.reasoningEffort, 'off')
})

test('选择器选了 auto：模型目录里还没登记 auto 时，按物理档位落值', async () => {
  const options = request('帮我修一下这个接口的报错')
  const outcome = await decideRequest(input(options, { policy: { minTier: 'off', maxTier: 'max', effortFloor: 'off', effortCeiling: 'max', effortId: 'auto' } }))
  assert.equal(outcome.action, 'applied')
  assert.ok(['high', 'max'].includes(outcome.effort))
})

test('选择器选了 auto：续跑与原样放行的分支必须摘掉这个虚拟值', async () => {
  const options = request('帮我改这个函数', {
    reasoningEffort: 'auto',
    messages: [
      { role: 'user', content: '帮我改这个函数' },
      { role: 'tool', content: 'done', toolCallId: 'c1' },
    ],
  })
  const outcome = await decideRequest(input(options, { policy: { minTier: 'off', maxTier: 'max', effortFloor: 'off', effortCeiling: 'max', effortId: 'auto' } }))
  assert.equal(outcome.action, 'continuation')
  assert.equal(Object.hasOwn(outcome.options, 'reasoningEffort'), false, '不能把 auto 交给适配器')
})

test('关闭档：选了 auto 也还原成模型默认，而不是把 auto 传下去', async () => {
  const options = request('你好', { reasoningEffort: 'auto' })
  const outcome = await decideRequest(input(options, { mode: 'off', policy: { effortId: 'auto' } }))
  assert.equal(outcome.action, 'disabled')
  assert.equal(Object.hasOwn(outcome.options, 'reasoningEffort'), false)
})

test('辅助调用：选了 auto 同样摘掉', async () => {
  const options = request('你好', { purpose: 'session-title', reasoningEffort: 'auto' })
  const outcome = await decideRequest(input(options, { policy: { effortId: 'auto' } }))
  assert.equal(outcome.action, 'auxiliary')
  assert.equal(Object.hasOwn(outcome.options, 'reasoningEffort'), false)
})

test('畸形输入不抛错', async () => {
  for (const options of [null, undefined, 42, 'x', {}]) {
    const outcome = await decideRequest(input(options))
    assert.ok(typeof outcome.action === 'string')
  }
})

test('applyTier：上界生效时把原因写进说明', () => {
  assert.deepEqual(applyTier('max', { minTier: 'off', maxTier: 'max' }), { tier: 'max', reason: '' })
  assert.equal(applyTier('max', { minTier: 'off', maxTier: 'low' }).tier, 'low')
  assert.equal(applyTier('max', { minTier: 'off', maxTier: 'low' }).reason, 'ceiling:low')
  assert.equal(applyTier('off', { minTier: 'high', maxTier: 'max' }).tier, 'high')
  assert.equal(applyTier('off', { minTier: 'high', maxTier: 'max' }).reason, 'floor:high')
  // 上下限互相矛盾时（min>max）下界最后生效：宁可多想，不可少想。
  assert.equal(applyTier('off', { minTier: 'high', maxTier: 'low' }).tier, 'high')
  assert.equal(applyTier('exotic', { minTier: 'off', maxTier: 'max' }).tier, 'high')
})

test('applyBounds：只有 observed / adapter-default 下界才把已有强度当边界', () => {
  assert.equal(applyBounds({ effortFloor: 'observed' }, 'max'), 'max')
  assert.equal(applyBounds({ effortFloor: 'adapter-default' }, 'max'), 'max')
  assert.equal(applyBounds({ effortFloor: 'observed' }, 'exotic'), 'off')
  assert.equal(applyBounds({ effortFloor: 'observed' }, undefined), 'off')
  assert.equal(applyBounds({ effortFloor: 'off' }, 'max'), 'off')
  assert.equal(applyBounds({ effortFloor: 'low' }, 'max'), 'off')
  assert.equal(applyBounds({}, 'max'), 'off')
})
