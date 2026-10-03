/**
 * 请求判定：把一次 `llm/stream` 请求变成"改不改、改成什么"。
 *
 * ## 判定只发生在一个地方
 *
 * 只在**用户消息触发的请求**上判定。工具结果回灌的续跑请求继续沿用同一条结论：
 * 模型在一次任务中途被换掉推理强度，等于让人写到一半改口径——既可能把已经开始的
 * 推理推倒重来，也会让 provider 侧的请求前缀白白失效。
 *
 * ## 判定失败一律不动请求
 *
 * 模型元数据取不到、effort 一个都不认识、读取消息时抛错——任何一种都只记一条
 * 日志并把请求原样放行。这个插件的失败模式只允许一个方向：退回"不装插件"。
 *
 * @module dsh-auto-effort/request
 */

import { clampEffort, classify, normalizeEfforts } from './classify.js'

/** 模型元数据缓存条数上限（provider+model 组合）。 */
const MODEL_CACHE_LIMIT = 32

/**
 * 判定并（必要时）改写一次请求。
 *
 * `observed === 'auto'` 是本插件往模型选择器里加的那个虚拟档位：它不是模型能力，
 * 只是"交给判定"的标记，因此不参与"用户手选值"的保护（手选 auto 就是要自动）。
 *
 * @param {object} input - 调用输入。
 * @param {object} input.options - `llm/stream` 观察到的 GenerateOptions（会被冻结，不直接改）。
 * @param {string} input.mode - 运行档：`auto` / `pin` / `off`。
 * @param {object} input.policy - 解析后的策略：`effortFloor` / `effortCeiling` / `maxTier` / `effortId`。
 * @param {object|null} input.llm - `llm` 服务；缺省时不做任何模型能力查询。
 * @param {(provider: string, model: string) => Promise<object|undefined>} [input.resolveModelInfo] - 模型元数据查询（便于测试注入）。
 * @param {Map<string, {at: number, value: object|undefined}>} [input.cache] - 模型元数据缓存。
 * @param {number} [input.now] - 当前时刻（便于测试注入）。
 * @param {number} [input.ttlMs] - 元数据缓存有效期。
 * @returns {Promise<{ options: object, decision: object|null, action: string, effort?: string }>}
 *   改写后的 options（未改写时就是原对象）、判定结果与动作说明。
 */
export async function decideRequest(input) {
  const { options, mode, policy } = input
  const chosen = typeof options?.reasoningEffort === 'string' && options.reasoningEffort !== '' ? options.reasoningEffort : undefined
  // `auto` 是虚拟档位，不是用户手选的强度：判定该照常接管它。
  const auto = chosen === (typeof policy?.effortId === 'string' && policy.effortId !== '' ? policy.effortId : 'auto')
  const observed = auto ? undefined : chosen
  const base = { options, decision: null, action: 'skip', effort: observed }

  if (mode === 'off') {
    // 关闭时虚拟档位必须还原成模型自己的默认（effort 留空），否则适配器会说它不认识 auto。
    return { ...base, options: auto ? withoutEffort(options) : options, action: 'disabled' }
  }
  if (options === null || typeof options !== 'object') return { ...base, action: 'invalid-request' }

  // 插件自己发起的辅助调用（会话标题、压缩摘要）不参与判定：它们的推理强度由
  // 各自的调用方决定，改它们只会让标题变慢或摘要变浅。虚拟档位仍要还原，否则
  // 适配器收到一个它不认识的 effort。
  if (typeof options.purpose === 'string' && options.purpose !== '') {
    return { ...base, options: auto ? withoutEffort(options) : options, action: 'auxiliary' }
  }

  const messages = options.messages
  if (!Array.isArray(messages) || messages.length === 0) return { ...base, action: 'no-messages' }

  const decision = classify({ messages, toolCount: Array.isArray(options.tools) ? options.tools.length : 0 })

  // 续跑请求：本次不改。续跑沿用同一条结论的方式就是"别再动它"，让模型在一次
  // 任务里保持同一个推理强度——重新判定会让已经开始的推理被推倒重来。
  // 虚拟档位是唯一的例外：适配器不认识它，必须还原成"模型默认"。
  if (decision.toolLoop || decision.reason === 'no-user-message') {
    return {
      ...base,
      options: auto ? withoutEffort(options) : options,
      decision,
      action: 'continuation',
    }
  }

  if (mode === 'pin' && observed !== undefined && !auto) {
    return { ...base, decision, action: 'pinned' }
  }

  const applied = applyTier(decision.tier ?? 'high', policy)
  const wanted = strongerTier(applied.tier, applyBounds(policy, observed))
  // 上下限生效时把原因并进说明，日志里能一眼看出"是判定说的还是配置改的"。
  const bounded = applied.reason === '' ? decision.reason : `${decision.reason}+${applied.reason}`

  const provider = typeof options.provider === 'string' ? options.provider : undefined
  const model = typeof options.model === 'string' ? options.model : undefined
  if (provider === undefined || model === undefined) {
    return {
      ...base,
      options: auto ? withoutEffort(options) : options,
      decision: { ...decision, tier: wanted, reason: bounded },
      action: 'no-route',
    }
  }

  const info = await lookupModelInfo(input, provider, model)
  const efforts = normalizeEfforts(info?.reasoning?.efforts)
  const effort = clampEffort({
    tier: wanted,
    efforts,
    defaultEffort: info?.reasoning?.defaultEffort,
    observedEffort: observed,
    effortFloor: policy.effortFloor,
    effortCeiling: policy.effortCeiling,
    effortId: policy.effortId,
  })
  const finalDecision = {
    ...decision,
    tier: wanted,
    reason: wanted === applied.tier ? bounded : `${bounded}+escalateOnly`,
    effort,
    defaultEffort: info?.reasoning?.defaultEffort,
  }
  // "算出来了但没法用"和"算出来正好等于现状"是同一件事：请求一个字都不用改。
  // 注意 effort 必须放在展开之后：`base` 里带着请求**原有**的 effort，先展开会把
  // 判定结果覆盖成 undefined，日志里就变成一句骗人的 `effort=-`。
  if (effort === undefined || effort === observed) {
    return { ...base, decision: finalDecision, action: 'unchanged', effort }
  }

  return {
    options: { ...options, reasoningEffort: effort },
    decision: finalDecision,
    action: 'applied',
    effort,
  }
}

/** 档位由弱到强的顺序；判定与限制都用它比较。 */
const TIER_ORDER = ['off', 'low', 'high', 'max']

/**
 * 去掉请求上的 `reasoningEffort`。
 *
 * 虚拟档位 `auto` 不属于任何模型的能力，必须在交给适配器之前摘掉：不是置成
 * `undefined`，而是真的没有这个键——适配器与宿主都用 `??` 取值，但"键存在且为
 * undefined"在经过 JSON 序列化、日志快照这些路径时行为并不一致，摘干净最省事。
 *
 * @param {object} options - 原请求。
 * @returns {object} 不带 `reasoningEffort` 的副本。
 */
function withoutEffort(options) {
  const { reasoningEffort: _dropped, ...rest } = options
  return rest
}

/**
 * 应用策略里的档位上下限。
 *
 * @param {'off'|'low'|'high'|'max'} tier - 判定出的档位。
 * @param {object} policy - 解析后的策略。
 * @returns {{ tier: 'off'|'low'|'high'|'max', reason: string }} 受限后的档位与说明。
 */
export function applyTier(tier, policy) {
  let next = TIER_ORDER.includes(tier) ? tier : 'high'
  let reason = ''
  const ceiling = typeof policy?.maxTier === 'string' ? policy.maxTier : 'max'
  const floor = typeof policy?.minTier === 'string' ? policy.minTier : 'off'
  if (TIER_ORDER.indexOf(next) > TIER_ORDER.indexOf(ceiling)) {
    next = ceiling
    reason = `ceiling:${ceiling}`
  }
  if (TIER_ORDER.indexOf(next) < TIER_ORDER.indexOf(floor)) {
    next = floor
    reason = `${reason === '' ? '' : `${reason}+`}floor:${floor}`
  }
  return { tier: next, reason }
}

/**
 * 把"请求上现有的推理强度"折成一个下界。
 *
 * `effortFloor` 为 `adapter-default`（默认）或 `observed` 时，请求上已有的强度就是
 * 下界。它只可能来自**用户的显式选择**：模型自己的默认档由 provider 在解析请求时
 * 补齐，不会出现在请求对象上。所以这条规则的实际含义是"不越过用户选过的强度"——
 * 用户选这个强度时已经表达了偏好，自动档不该把它悄悄降下来。
 *
 * @param {object} policy - 解析后的策略。
 * @param {string|undefined} observed - 请求上现有的 effort id。
 * @returns {'off'|'low'|'high'|'max'} 下界档位。
 */
export function applyBounds(policy, observed) {
  if (policy?.effortFloor !== 'adapter-default' && policy?.effortFloor !== 'observed') return 'off'
  if (typeof observed !== 'string' || !TIER_ORDER.includes(observed)) return 'off'
  return /** @type {'off'|'low'|'high'|'max'} */ (observed)
}

/**
 * @param {'off'|'low'|'high'|'max'} a - 档位。
 * @param {'off'|'low'|'high'|'max'} b - 档位。
 * @returns {'off'|'low'|'high'|'max'} 两者中更强的一个。
 */
function strongerTier(a, b) {
  const left = TIER_ORDER.indexOf(a)
  const right = TIER_ORDER.indexOf(b)
  return left >= right ? a : b
}

/**
 * 读取模型元数据，带 TTL 缓存。
 *
 * 深层实现（DeepSeek 适配器）是纯内存查表，但 provider 插件可以自由实现成网络查询，
 * 所以这里必须缓存：每次请求都问一遍会把插件变成延迟来源。查询失败缓存为
 * `undefined`（短 TTL），避免失败时每一步都重试。
 *
 * @param {object} input - 与 {@link decideRequest} 相同的输入。
 * @param {string} provider - provider id。
 * @param {string} model - 模型 id。
 * @returns {Promise<object|undefined>} 模型元数据。
 */
async function lookupModelInfo(input, provider, model) {
  const cache = input.cache
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now()
  const ttl = Number.isFinite(input.ttlMs) ? Number(input.ttlMs) : 300_000
  const key = `${provider}\u0000${model}`
  if (cache !== undefined) {
    const hit = cache.get(key)
    if (hit !== undefined && now - hit.at < ttl) return hit.value
  }

  let value
  try {
    // 显式传入的查询函数优先于 `llm`：测试与替身场景必须能覆盖真实服务，
    // 否则"注入了却没用"会让人以为断言通过。
    const resolve = typeof input.resolveModelInfo === 'function'
      ? input.resolveModelInfo
      : typeof input.llm?.resolveModelInfo === 'function'
        ? (p, m) => input.llm.resolveModelInfo(p, m)
        : undefined
    if (resolve !== undefined) value = await resolve(provider, model)
  } catch {
    value = undefined
  }

  if (cache !== undefined) {
    if (cache.size >= MODEL_CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { at: now, value })
  }
  return value
}
