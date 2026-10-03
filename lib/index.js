/**
 * dsh-auto-effort —— Host 半边：推理等级 auto。
 *
 * ## 这个插件解决的问题
 *
 * 推理强度必须在**请求发出之前**定下来：它决定服务端要不要开思考、思考多深。
 * 所以"让模型自己在需要时多想"只能由请求这一侧来做——判定发生在 `llm/stream`
 * 瀑布上，读的正是这次请求要发出去的消息。判定是纯规则，0 token、0 往返。
 *
 * ## 它只做一件事
 *
 * 用户消息触发的请求，判一个档位（`off` / `low` / `high` / `max`），落成该模型真的
 * 支持的 effort id，写进这次调用的 `reasoningEffort`。别的一律不碰：不改消息、不改
 * 系统提示、不改工具表、不改采样参数、不注册工具、不加额外模型调用。
 *
 * ## 改写为什么要重新进入瀑布
 *
 * 调用方交给瀑布的 `options` 是 `Object.freeze` 过的（宿主这样保证请求头不被静默
 * 篡改），改不动。所以本插件挂在瀑布**末位**：拿不到要改的结论就 `next()` 放行；
 * 拿得到就用一份改了 `reasoningEffort` 的新 options 重新调用 `ctx.llm.stream()`。
 * 重入时判定结果与请求上已有的值相同，于是直接 `next()` 到底——不会递归。
 *
 * ## 续跑请求不再判定
 *
 * 工具结果回灌的续跑请求末尾不是用户消息。此时重新判定等于让模型在一次任务中途改
 * 口径：已经开始的推理可能被推倒重来，provider 侧的前缀也要重新计价。所以一条结论
 * 管一整轮：判定只在用户消息上发生，续跑原样放行（自然继承上一次的 effort）。
 *
 * ## 为什么不问 `isAgentLoopRequest`
 *
 * 宿主用 `@deepseek-ai/dsh-llm` 里按模块实例身份标记的 WeakSet 判断"这条请求是不是
 * agent 循环装配的"。插件 `import` 到的是**另一个模块实例**，于是它对宿主的每条请求
 * 都回 false——本机实测：自动档一次都没生效，`stats.last.action` 全是 `foreign`。
 * 所以这里不做这个判断：靠 `purpose`（标题/压缩）+ "末尾是不是用户消息" 两条，已经
 * 覆盖了实际会遇到的调用；最坏也只是多看几条外部请求，判定本身仍然安全。
 *
 * ## 失败模式只允许一个方向
 *
 * 模型元数据取不到、effort 一个都不认识、消息读不动——一律原样放行并记一条日志。
 * 最坏情况退化成"不装这个插件"，绝不会让请求失败或让模型收到非法值。
 *
 * @module dsh-auto-effort
 */

import { TIERS } from './classify.js'
import { Config, resolveConfig } from './schema.js'
import { RUN_MODES, ToggleState, resolveDshHome, statePath } from './state.js'
import { decideRequest } from './request.js'

/** 插件名；bundle 补丁里的 `name` 必须与它一致。 */
export const name = 'auto-effort'

export { Config }

/**
 * 需要的服务：`llm`（判定读的就是它）与 `webServer`（开关端点）。
 *
 * ## 为什么 `webServer` 必须写进 inject
 *
 * 本机实测（干净的 web profile，2026-10-03）：用 `ctx.get('webServer')` 取服务时拿到
 * 的是 `undefined`，路由因此从来没注册过——插件看起来"装好了"，端点却一直 404。
 * 改成注入并用 `ctx.webServer` 之后同一个 profile 立刻返回 200。`ctx.get()` 的严格
 * 语义在这个上下文里拿不到由别的 fiber 提供的服务，而注入会等服务就位。
 *
 * 代价是没有 webServer 的 profile（例如 headless）里本插件会停在 pending、不激活。
 * 这是刻意的取舍：这个插件的可见性就是那枚胶囊，没有界面时"隐形改写推理强度"比
 * 不装更糟；要跑无界面的环境，就把它从那个 profile 的 bundles 里去掉。
 */
export const inject = ['llm', 'webServer']

/** 开关端点路径：带 `dsh-` 前缀，不会与宿主或别的插件撞路径。 */
export const ROUTE_PATH = '/dsh-auto-effort'

/** 模型元数据缓存有效期：能力声明在一次会话里不会变。 */
const MODEL_INFO_TTL_MS = 300_000

/** 判定统计与最近一次结果：给界面与排查用。 */
export class EffortStats {
  constructor() {
    /** @type {number} */
    this.applied = 0
    /** @type {number} */
    this.unchanged = 0
    /** @type {number} */
    this.skipped = 0
    /** @type {object|null} */
    this.last = null
  }

  /**
   * 记一次判定。
   *
   * @param {{ action: string, decision: object|null, effort?: string }} outcome - 判定结果。
   * @param {{ provider: string, model: string, at: number }} request - 路由信息。
   */
  record(outcome, request) {
    if (outcome.action === 'applied') this.applied += 1
    else if (outcome.action === 'unchanged') this.unchanged += 1
    else this.skipped += 1
    this.last = {
      at: request.at,
      action: outcome.action,
      provider: request.provider,
      model: request.model,
      tier: outcome.decision?.tier ?? null,
      effort: outcome.effort ?? null,
      reason: outcome.decision?.reason ?? null,
      score: outcome.decision?.score ?? null,
    }
  }
}

/**
 * 装配。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - bundle 补丁里的 config。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const state = new ToggleState({
    initial: config.enabled ? config.mode : 'off',
    file: config.persist ? statePath(resolveDshHome()) : undefined,
    onError: (error) => ctx?.logger?.warn?.(`auto-effort: state write failed: ${error?.message ?? error}`),
  })
  const stats = new EffortStats()
  const cache = new Map()
  /**
   * 本会话上一次判定落成的档位。
   *
   * `auto` 只是选择器的标记，适配器必须拿到具体档位；而一次任务中途的续跑请求不该
   * 换档。这两件事都由这张表满足：写进去的是判定值，读出来的是"这个会话现在用多深"。
   * 键为 sessionId，容量封顶以免长期运行时无限增长。
   */
  const perSession = new Map()
  /** 最近一次请求的会话 id：只用于诊断端点（`?selection=1`）。 */
  let lastSessionId = undefined
  /**
   * 最近若干次判定的流水（环形，最多 40 条）。
   *
   * 记录**请求原本带的档位**（`chosen`）与**最终发给适配器的档位**（`effort`）——判断
   * "选 auto 是否生效、选 high 是否不生效"靠的就是这两列，而 `stats` 里只有计数。
   */
  const recent = []
  /**
   * 本会话**仍在进行的那件事**：`{ tier, age }`。
   *
   * 给"含糊短追问"用：一句"那块再收一下"该按任务分量走，而不是按句子长度走。
   * `age` 是它之后已经过了几条用户消息——跨过太多轮说明那件事翻篇了。
   * **闲聊不清空这个槽位**：任务中间夹一句"好的"，下一句"继续"仍然属于同一件事。
   * 只记档位与计数，不记内容。
   */
  const tasks = new Map()
  const taskOf = (sessionId) => (typeof sessionId === 'string' ? tasks.get(sessionId) : undefined)
  const rememberTask = (sessionId, tier, maxAge) => {
    if (typeof sessionId !== 'string' || typeof tier !== 'string') return
    if (tasks.size >= 64 && !tasks.has(sessionId)) {
      const oldest = tasks.keys().next()
      if (!oldest.done) tasks.delete(oldest.value)
    }
    tasks.set(sessionId, { tier, age: 0, maxAge })
  }
  /**
   * 一轮结束时给任务槽位增龄。
   *
   * 语义是"任务之后完整经过了几条用户消息"：判定**读**这个值（那一轮它还没增），
   * 轮末才 +1。所以 `taskMaxAge = 3` 表示任务之后的第 1、2、3 条消息仍可继承。
   */
  /** 任务翻篇：用户转向了带具体锚点的新事情。 */
  const forgetTask = (sessionId) => {
    if (typeof sessionId === 'string') tasks.delete(sessionId)
  }
  const ageTask = (sessionId) => {
    const task = taskOf(sessionId)
    if (task === undefined) return
    task.age += 1
  }

  /** 本会话上一次判定落成的档位：`auto` 交给适配器前要靠它换成具体值。 */
  const sessionEffort = (sessionId) => (typeof sessionId === 'string' ? perSession.get(sessionId) : undefined)
  const rememberEffort = (sessionId, effort) => {
    if (typeof sessionId !== 'string' || typeof effort !== 'string' || effort === config.effortId) return
    if (perSession.size >= 64 && !perSession.has(sessionId)) {
      const oldest = perSession.keys().next()
      if (!oldest.done) perSession.delete(oldest.value)
    }
    perSession.set(sessionId, effort)
  }
  /** 本插件自己重入过的请求对象：只用来保证重入不重复计数。 */
  const reentered = new WeakSet()

  /**
   * 解析一个宿主服务。
   *
   * **必须在每个请求上重新解析**，不能只捕获装配那一刻的值：`inject` 只保证依赖在图里，
   * 不保证 `apply` 执行时提供者已经就位。实测踩过——捕获到 undefined 后，每次请求都会
   * 抛 `Cannot read properties of undefined`，而宿主看起来一切正常。
   *
   * @param {string} key - 服务名。
   * @returns {object|undefined} 服务对象。
   */
  const service = (key) => {
    const fromGet = typeof ctx.get === 'function' ? ctx.get(key) : undefined
    if (fromGet !== undefined) return fromGet
    return ctx[key]
  }

  const policy = {
    effortId: config.effortId,
    minTier: config.minTier,
    maxTier: config.maxTier,
    effortFloor: config.effortFloor,
    effortCeiling: config.effortCeiling,
  }

  /**
   * 判定一次请求并给出最终 options。任何异常都退回原请求。
   *
   * @param {object} options - 瀑布观察到的请求。
   * @param {string} mode - 当前运行档。
   * @param {string} provider - provider id。
   * @param {string} model - 模型 id。
   * @returns {Promise<{ options: object, outcome: object }>} 最终 options 与判定结果。
   */
  async function evaluate(options, mode, provider, model) {
    try {
      const outcome = await decideRequest({
        options,
        mode,
        policy,
        llm: service('llm'),
        previousTask: taskOf(options?.sessionId),
        cache,
        ttlMs: MODEL_INFO_TTL_MS,
      })
      return { options: outcome.options, outcome }
    } catch (error) {
      ctx?.logger?.warn?.(`auto-effort: decide failed, request unchanged: ${error?.stack ?? error}`)
      return { options, outcome: { action: 'error', decision: null } }
    }
  }

  ctx.effect(
    () =>
      ctx.on(
        'llm/stream',
        (options, next) => {
          const mode = state.get()
          if (mode === 'off') return next()

          const provider = typeof options?.provider === 'string' ? options.provider : ''
          const model = typeof options?.model === 'string' ? options.model : ''
          const counted = reentered.has(options)

          const wrapped = (async function* stream() {
            const { options: decided, outcome } = await evaluate(options, mode, provider, model)
            if (!counted) {
              if (typeof options?.sessionId === 'string') lastSessionId = options.sessionId
              // 只要算出了具体档位就记：判成 unchanged 时同样是"本会话当前用多深"。
              if (typeof outcome.effort === 'string') rememberEffort(options?.sessionId, outcome.effort)
              // 任务槽位的推进规则（只对"用户消息触发的判定"生效，续跑不动它）：
              //   * 命中继承 → 同一件事还在跑，只增龄；
              //   * 判到 high/max → 这是"那件事"，重新记入（age 归零）；
              //   * 其余（轻任务、闲聊、收尾）→ 只增龄，不清空：任务中间夹一句"好的"，
              //     下一句"继续"仍然属于同一件事。
              const verdict = outcome.decision
              if (typeof options?.sessionId === 'string' && verdict !== null && verdict.toolLoop !== true && typeof verdict.tier === 'string') {
                // 规则（只对"用户消息触发的判定"生效，续跑不动它）：
                //   * 命中继承 → 同一件事还在跑，只增龄；
                //   * 判到 high/max → 这就是"那件事"，重新记入（age 归零）；
                //   * 没继承、判得又轻，但**消息自带具体锚点**（路径/命令/交付物）→ 用户已经
                //     转到别的事情上了，旧任务槽位作废。留着它只会让后面的"继续"继承一个
                //     早就翻篇的任务（实测踩过）；
                //   * 其余（纯闲聊、寒暄、收尾）→ 只增龄，不清空：任务中间夹一句"好的"，
                //     下一句"继续"仍然属于同一件事。
                const anchoredTurn = verdict.anchored === true
                if (verdict.inherited !== true && TIERS.indexOf(verdict.tier) >= 2) {
                  rememberTask(options.sessionId, verdict.tier, config.taskMaxAge)
                } else if (verdict.inherited !== true && anchoredTurn) {
                  forgetTask(options.sessionId)
                } else {
                  ageTask(options.sessionId)
                }
              }
              // 决策流水：`chosen`（请求原本带的档位）与 `effort`（最终发给适配器的档位）
              // 并排记录——"选 auto 是否生效、选 high 是否不生效"看这两列即可。
              recent.push({
                at: Date.now(),
                chosen: typeof options?.reasoningEffort === 'string' ? options.reasoningEffort : null,
                // 判定与适配器两侧的对照：`chosen` 是请求原本带的（可能是虚拟档位 auto），
                // `effort` 是最终发给适配器的。手选具体档位时两者必须相等。
                observed: typeof outcome.options?.reasoningEffort === 'string' ? outcome.options.reasoningEffort : null,
                action: outcome.action,
                tier: outcome.decision?.tier ?? null,
                effort: outcome.effort ?? null,
                reason: outcome.decision?.reason ?? null,
                score: outcome.decision?.score ?? null,
                inherited: outcome.decision?.inherited === true,
                anchored: outcome.decision?.anchored === true,
              })
              if (recent.length > 40) recent.shift()
              stats.record(outcome, { provider, model, at: Date.now() })
              if (config.log) {
                const detail = outcome.decision === null
                  ? outcome.action
                  : `tier=${outcome.decision.tier} effort=${outcome.effort ?? '-'} score=${outcome.decision.score} why=${outcome.decision.reason}`
                ctx?.logger?.info?.(`auto-effort: ${outcome.action} ${provider}/${model} ${detail}`)
              }
            }
            if (decided === options) {
              yield* next()
              return
            }
            // 重新进入瀑布：这次带的是改写后的推理强度。重入会被本监听者再次看到，
            // 此时判定结果与请求上的值一致，于是直接走到底。
            reentered.add(decided)
            const runtime = service('llm')
            if (runtime === undefined) {
              ctx?.logger?.warn?.('auto-effort: llm service unavailable, request passed through unchanged')
              yield* next()
              return
            }
            yield* runtime.stream(decided)
          })()
          return wrapped
        },
        { global: true },
      ),
    'auto-effort: llm/stream',
  )

  /**
   * 把虚拟档位 `auto` 接进宿主的必经路径。
   *
   * **这一段与开关无关，永远安装。** 它管的是"虚拟档位不外泄"这一层正确性：
   * `auto` 不是任何模型的能力，落到适配器上就会被判为不支持的推理强度。开关只决定
   * "要不要按任务改档位"，不该决定"要不要把虚拟值翻译掉"——早先把两者绑在一起，
   * 关闭档位时适配器会直接收到 `auto`（实测发现）。
   *
   * 一共四处，缺一处就会出现"看着能用、实际报错"或"选完显示成别的档位"：
   *
   * 1. `resolveModelInfo`：模型选择器的推理等级列表就是这份元数据，往里追加一条
   *    `{ id: 'auto', name: 'Auto' }`，"自动"就成了 low/high/max 旁边的一个选项。
   * 2. `stream`：适配器只认识真实档位。这里在**不改变请求对象**的前提下，把交给
   *    适配器的副本里的 `auto` 换成具体档位（本会话上一次判定值；没有就用模型默认）。
   *    请求对象本身仍写着 `auto`——宿主正是用它回显"你选的是自动"。
   * 3. `prepareCall`：它决定请求头里记录什么。原样把调用方的配置写回去，选择器与
   *    会话恢复才能看到 `Auto` 而不是被换成模型默认档。
   * 4. `resolveCallConfig` / `resolveCallFor`：同类入口，适配器同样不能看到 `auto`。
   *
   * 早先版本只做了 1 和"摘掉再还原"，结果是选择器显示 high：宿主把"和适配器默认
   * 相同"的档位判定为未选择，回读时直接丢掉了它。修法是**不再让 auto 与默认档相等**：
   * 请求头记录 Auto，适配器拿到的是真实档位，两者不再共享一个字段。
   */
  ctx.effect(() => {
    const llm = service('llm')
    if (llm === undefined || llm === null) {
      ctx?.logger?.warn?.('auto-effort: llm service unavailable at install; model catalog will not show Auto until restart')
      return () => {}
    }
    const restore = []
    /** 换掉 `llm` 上的一个方法，并登记恢复动作。 */
    const replace = (name, factory) => {
      const original = llm[name]
      if (typeof original !== 'function') return
      try {
        llm[name] = factory(original)
        restore.push(() => {
          llm[name] = original
        })
      } catch (error) {
        ctx?.logger?.warn?.(`auto-effort: cannot wrap ${name}: ${error?.message ?? error}`)
      }
    }

    // 1) 模型目录：让"自动"成为推理等级列表里的一个选项。
    //    注意它的入参是 (provider, model)，与下面几个吃 callConfig 的方法不同。
    replace('resolveModelInfo', (original) => async function resolveModelInfo(provider, model, signal) {
      // `Reflect.apply` 而不是 `.call`：远程边界可能把这个方法解绑后调用。
      const info = await Reflect.apply(original, llm, [provider, model, signal])
      return withAutoEffort(info, config)
    })

    // 2) 出站调用：适配器只看到真实档位。
    replace('stream', (original) => function stream(options) {
      return Reflect.apply(original, llm, [withoutVirtualEffort(options, config, sessionEffort)])
    })

    // 3)+4) 请求装配的三个入口。
    replace('prepareCall', (original) => async function prepareCall(callConfig, signal) {
      const result = await Reflect.apply(original, llm, [withoutVirtualEffort(callConfig, config, sessionEffort), signal])
      return throughAuto(result, callConfig, config, sessionEffort)
    })
    for (const name of ['resolveCallConfig', 'resolveCallFor']) {
      replace(name, (original) => async function guarded(...args) {
        const callConfig = args[0]
        const result = await Reflect.apply(original, llm, [withoutVirtualEffort(callConfig, config, sessionEffort), ...args.slice(1)])
        return throughAuto(result, callConfig, config, sessionEffort)
      })
    }
    return () => {
      for (const undo of restore) undo()
    }
  }, 'auto-effort: model catalog + call-config guards')

  ctx.effect(() => {
    void state.load().then((loaded) => {
      if (loaded) ctx?.logger?.info?.(`auto-effort: restored mode=${state.get()}`)
    })
    return () => {}
  }, 'auto-effort: state load')

  // 注入保证它存在；这里只是不让装配因为宿主实现差异而中断。
  const webServer = service('webServer')
  if (webServer?.register !== undefined) {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              const mode = state.get()
              // 诊断用：`?catalog=provider/model` 回报那条路由**经过本插件之后**的推理
              // 等级列表。模型选择器读的就是这份数据，"Auto 没出现在列表里"是最常见的
              // 一类故障，有了它就不用靠猜（只读，不回显密钥）。
              if (typeof req.url === 'string' && req.url.includes('selection=1')) {
                sendJson(res, 200, selectionProbe(ctx, lastSessionId))
                return
              }
              if (typeof req.url === 'string' && req.url.includes('decisions=1')) {
                sendJson(res, 200, { decisions: recent.slice(-20) })
                return
              }
              const probe = await requestProbe(req.url, service('llm'))
              if (probe !== undefined) {
                sendJson(res, 200, probe)
                return
              }
              sendJson(res, 200, {
                mode,
                modes: RUN_MODES,
                enabled: mode !== 'off',
                config: {
                  mode: config.mode,
                  enabled: config.enabled,
                  // 生效的边界必须可见：用户排查"为什么它动了我的档位"时，第一眼要看到这三个。
                  effortFloor: config.effortFloor,
                  effortCeiling: config.effortCeiling,
                  minTier: config.minTier,
                  maxTier: config.maxTier,
                  taskMaxAge: config.taskMaxAge,
                  effortId: config.effortId,
                  effortName: config.effortName,
                  autoDefault: config.autoDefault,
                },
                stats: { applied: stats.applied, unchanged: stats.unchanged, skipped: stats.skipped },
                last: stats.last,
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method-not-allowed' })
              return
            }
            const body = await readJsonBody(req)
            if (body === undefined) {
              sendJson(res, 400, { error: 'invalid-body' })
              return
            }
            // 浏览器半边会在"用户手动选了真实等级"时发 `{ auto: false }`，
            // 只用于让端点里的最近一次判定不误导排查；档位本身完全由请求决定。
            if (body.auto === false) {
              sendJson(res, 200, { auto: false })
              return
            }
            const mode = state.set(body.mode)
            sendJson(res, 200, { mode, enabled: mode !== 'off' })
          },
        }),
      'auto-effort: toggle endpoint',
    )
  } else {
    ctx?.logger?.warn?.('auto-effort: webServer unavailable, running without the UI switch')
  }
}

/**
 * 读一个小 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<object|undefined>} 解析结果；坏 JSON 或非对象返回 undefined。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 统一响应：永远 JSON、永远 no-store。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - JSON 载荷。
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 往模型元数据里追加"自动"档位。
 *
 * 只在模型**本来就有**推理等级时追加：没有思考能力的模型不该出现一个"自动"选项。
 * 已经是默认档位（`defaultEffort` 未声明）时也不用动——选择器本来就会显示"提供方默认"。
 *
 * @param {object|undefined} info - `llm.resolveModelInfo` 的结果。
 * @param {{ effortId: string, effortName: string, autoDefault: boolean }} config - 解析后的配置。
 * @returns {object|undefined} 追加后的元数据（不修改入参）。
 */
export function withAutoEffort(info, config) {
  const reasoning = info?.reasoning
  if (reasoning === null || typeof reasoning !== 'object' || !Array.isArray(reasoning.efforts)) return info
  if (reasoning.efforts.some((level) => level?.id === config.effortId)) return info
  return {
    ...info,
    reasoning: {
      ...reasoning,
      efforts: [...reasoning.efforts, { id: config.effortId, name: config.effortName, description: config.effortDescription }],
      ...config.autoDefault ? { defaultEffort: config.effortId } : {},
    },
  }
}

/**
 * 诊断查询：模型选择器读到的推理等级列表，以及请求装配那一步会不会出错。
 *
 * - `?catalog=provider/model`：回报**经过本插件之后**的推理等级列表。
 * - `?prepareCall=provider/model`：拿 `reasoningEffort: 'auto'` 真的走一遍宿主的
 *   请求装配，回报成功或确切错误。这一条是"菜单操作失败"的定位手段：报错信息里
 *   会直接指出是哪一层拒绝了这个档位。
 * - `?stream=provider/model`：只建立出站调用（不消费），确认适配器那一层也不会因为
 *   虚拟档位报错。
 *
 * @param {string|undefined} url - 请求 URL。
 * @param {object|undefined} llm - `llm` 服务。
 * @returns {Promise<object|undefined>} 查询结果。
 */
async function requestProbe(url, llm) {
  if (typeof url !== 'string') return undefined
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const params = new URLSearchParams(query)
  const catalog = params.get('catalog')
  const prepare = params.get('prepareCall')
  const stream = params.get('stream')
  const raw = catalog ?? prepare ?? stream
  if (raw === null || raw === '') return undefined
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return { route: raw, error: 'expected provider/model' }
  const provider = raw.slice(0, slash)
  const model = raw.slice(slash + 1)
  try {
    if (catalog !== null && catalog !== '') {
      const info = await llm?.resolveModelInfo?.(provider, model)
      return { route: raw, efforts: info?.reasoning?.efforts, defaultEffort: info?.reasoning?.defaultEffort }
    }
    if (stream !== null && stream !== '') {
      // 走一遍真实出站路径：适配器若收到它不认识的档位，这里会当场报错。
      // 不消费返回的迭代器（那会真的发请求），只看"能不能建立"。
      const iterable = llm?.stream?.({ provider, model, reasoningEffort: 'auto', messages: [{ role: 'user', content: 'probe' }] })
      return { route: raw, ok: iterable !== undefined && iterable !== null, kind: typeof iterable?.[Symbol.asyncIterator] }
    }
    const prepared = await llm?.prepareCall?.({ provider, model, reasoningEffort: 'auto' })
    return {
      route: raw,
      ok: true,
      config: prepared?.config ?? null,
    }
  } catch (error) {
    return { route: raw, ok: false, error: error?.message ?? String(error) }
  }
}

/**
 * 判断一份配置选的是不是虚拟档位。
 *
 * @param {object} value - 任意 callConfig。
 * @param {{ effortId: string }} config - 解析后的配置。
 * @returns {boolean} 是否选中了虚拟档位。
 */
export function isVirtualEffort(value, config) {
  return value !== null && typeof value === 'object' && value.reasoningEffort === config.effortId
}

/**
 * 把交给适配器的配置里的虚拟档位换成真实档位。
 *
 * **不改调用方的对象**：宿主正是靠请求对象上的 `auto` 回显"你选的是自动"，改掉它
 * 就会出现"选完显示成 high"。这里返回的是给适配器的副本。
 *
 * @param {object} value - 原配置或请求。
 * @param {{ effortId: string }} config - 解析后的配置。
 * @param {(sessionId: string) => string|undefined} sessionEffort - 本会话上一次判定值。
 * @returns {object} 适配器能接受的配置。
 */
export function withoutVirtualEffort(value, config, sessionEffort = () => undefined) {
  if (!isVirtualEffort(value, config)) return value
  const { reasoningEffort: _dropped, ...rest } = value
  const remembered = sessionEffort(value.sessionId)
  if (remembered === undefined) return rest
  // 续跑请求沿用本会话上一次判定值：一次任务中途不该换档，也不该退回模型默认。
  return { ...rest, reasoningEffort: remembered }
}

/**
 * 请求装配结果：让**记录**保留 Auto，让**适配器**只看到真实档位。
 *
 * @param {unknown} result - `prepareCall` 一类方法的返回值。
 * @param {object} originalConfig - 调用方原始配置。
 * @param {{ effortId: string }} config - 解析后的配置。
 * @param {(sessionId: string) => string|undefined} sessionEffort - 本会话上一次判定值。
 * @returns {unknown} 处理后的返回值。
 */
export function throughAuto(result, originalConfig, config, sessionEffort = () => undefined) {
  if (result === null || typeof result !== 'object') return result
  const virtual = isVirtualEffort(originalConfig, config)
  const next = { ...result }
  if (result.config !== null && typeof result.config === 'object') {
    next.config = virtual ? { ...result.config, reasoningEffort: config.effortId } : result.config
  }
  const inner = result.stream
  if (virtual && typeof inner === 'function') {
    next.stream = (options) => Reflect.apply(inner, result, [withoutVirtualEffort(options, config, sessionEffort)])
  }
  return next
}

/**
 * 诊断：宿主当前认为"这个会话选的是哪个档位"。
 *
 * 模型选择器显示什么，最终取自这份选择（会话日志里的 `model/selection` 或请求头）。
 * 界面显示 high 而请求里是 Auto 时，用它能一眼看出是哪一侧丢了。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {string|undefined} sessionId - 最近一次请求的会话 id。
 * @returns {object} 诊断结果。
 */
export function selectionProbe(ctx, sessionId) {
  const result = { sessionId: sessionId ?? null, sessions: typeof ctx.get === 'function' && ctx.get('sessions') !== undefined }
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (sessions === undefined || agents === undefined || typeof sessionId !== 'string') return result
    const list = typeof agents.list === 'function' ? agents.list() : []
    const agent = list.find((entry) => entry?.session?.id === sessionId)
    if (agent === undefined) return { ...result, error: 'agent not found for session' }
    const state = sessions.stateOf(agent.session, 'modelSelection')
    result.projection = state ?? null
    result.header = agent.session.requestHeader()?.config ?? null
  } catch (error) {
    result.error = error?.message ?? String(error)
  }
  return result
}
