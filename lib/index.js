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
import { AUTO_EFFORT_ID } from './efforts.js'
import { resolveDirective } from './directive.js'
import { Config, resolveConfig } from './schema.js'
import { RUN_MODES, ToggleState, resolveDshHome, statePath } from './state.js'
import { decideRequest } from './request.js'

/**
 * 判定的硬超时（毫秒）。
 *
 * 判定本身是纯规则、微秒级；唯一的外部等待是查模型元数据。**给这条路径加硬上限**：
 * 超时就按"不改写"放行——最坏结果是这一次没优化，绝不会让请求卡住。
 */
const DECIDE_TIMEOUT_MS = 1500

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
export const inject = ['llm', 'webServer', 'systemPrompt']

/**
 * 精简化段落在系统提示词里的位置：**最后**，不动前面任何一段的前缀缓存。
 *
 * 名字必须**唯一**：早期版本沿用 `dsh-concise-output` 的 `output:concise`，而那个
 * 插件仍装着时，同名注册会被宿主拒绝——整段注册抛错，插件因此被静默丢弃（实测：
 * 路由 404、界面上的图标消失）。所以这里用自己的命名空间。
 */
const CONCISE_SECTION = 'auto-effort:concise'
const CONCISE_ORDER = 10200

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
  /**
   * "精简化"开关的内存状态。
   *
   * 与 `auto` 共用同一个状态文件（`{ mode, armed, concise }`），所以两个开关一起
   * 持久化、一起恢复，不额外多一个文件。
   */
  const conciseOf = () => state.getConcise()

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
  /** 出站守卫的安装情况：端点要能看到，否则"菜单里没有 Auto"只能靠猜。 */
  const guardState = { attempted: false, installed: [] }
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
    if (typeof sessionId !== 'string' || typeof effort !== 'string' || effort === AUTO_EFFORT_ID) return
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
    effortId: AUTO_EFFORT_ID,
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
      // 硬超时：判定或元数据查询卡住时按"原样放行"处理，绝不拖住这次请求。
      let timer
      const outcome = await Promise.race([
        decideRequest({
          options,
          mode,
          policy,
          llm: service('llm'),
          previousTask: taskOf(options?.sessionId),
          autoArmed: state.getArmed(),
          cache,
          ttlMs: MODEL_INFO_TTL_MS,
        }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ action: 'timeout', decision: null, options }), DECIDE_TIMEOUT_MS)
        }),
      ]).finally(() => clearTimeout(timer))
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
            // 重入一次就够：同一个请求对象再进来时，判定结果必然与请求上的值一致
            // （否则就是判定自己不稳定）。这里再加一道闸：已经重入过的请求对象直接放行，
            // 绝不会出现"改写→重入→再改写"的循环。
            if (reentered.has(decided)) {
              yield* next()
              return
            }
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

  // 精简化段落：注册在系统提示词**最后**（order 10200），开关不变时逐字节稳定，
  // 不产生额外前缀缓存失效；只有你主动拨开关的那一次会从这一段起重新计费一次。
  ctx.effect(
    () => service('systemPrompt')?.section?.({
      name: CONCISE_SECTION,
      order: CONCISE_ORDER,
      text: () => resolveDirective(conciseOf()),
    }),
    'auto-effort: concise section',
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
    guardState.attempted = true
    /** 换掉 `llm` 上的一个方法，并登记恢复动作。 */
    const replace = (name, factory) => {
      const original = llm[name]
      if (typeof original !== 'function') return
      try {
        llm[name] = factory(original)
        guardState.installed.push(name)
        restore.push(() => {
          llm[name] = original
        })
      } catch (error) {
        ctx?.logger?.warn?.(`auto-effort: cannot wrap ${name}: ${error?.message ?? error}`)
      }
    }

    // 1) 出站调用：适配器只看到真实档位。
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
              if (typeof req.url === 'string' && req.url.includes('switches=1')) {
                // 优化面板的开关登记表。**这是给别的插件用的扩展点**：
                // 任何插件只要把自己的端点挂进来、并实现 `{ enabled }` 的 GET/POST 约定，
                // 就会出现在面板里，不需要改本插件的代码。
                sendJson(res, 200, {
                  switches: [
                    {
                      id: AUTO_EFFORT_ID,
                      label: { zh: '自动化推理等级', en: 'Adaptive reasoning effort' },
                      hint: {
                        zh: '按任务轻重自动选择推理强度；关掉后完全不动你的选择。',
                        en: 'Picks the reasoning effort per task; when off it never touches your choice.',
                      },
                      endpoint: ROUTE_PATH,
                      field: 'enabled',
                    },
                    {
                      id: 'concise',
                      label: { zh: '精简化输出', en: 'Concise output' },
                      hint: {
                        zh: '压掉开场白与复述，只留事实与下一步；任务内容一个字不变。',
                        en: 'Drops preambles and restatements; the task itself is unchanged.',
                      },
                      endpoint: ROUTE_PATH,
                      field: 'concise',
                      // 与 auto 共用同一个端点：面板一次读回两个开关的状态。
                      sameEndpoint: true,
                    },
                  ],
                })
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
                  armed: state.getArmed(),
                  concise: conciseOf(),
                  enabled: config.enabled,
                  // 生效的边界必须可见：用户排查"为什么它动了我的档位"时，第一眼要看到这三个。
                  effortFloor: config.effortFloor,
                  effortCeiling: config.effortCeiling,
                  minTier: config.minTier,
                  maxTier: config.maxTier,
                  taskMaxAge: config.taskMaxAge,
                  guards: { attempted: guardState.attempted, installed: [...guardState.installed] },
                  effortId: AUTO_EFFORT_ID,
                },
                // 通用开关协议：面板只认这些布尔字段，别的插件照这个形状实现即可。
                enabled: state.getArmed(),
                concise: conciseOf(),
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
            // 浏览器半边在模型选择器里选中/离开 `auto` 时通知这里。
            // 选中 auto 就置位：此后判定接管每一个请求，不再依赖宿主把 auto 写回会话
            // —— 实测那一步不可靠（点了 Auto，会话里记的仍是 high/max）。
            // 通用开关协议：`{ enabled: boolean }`（面板用）。旧的 `{ auto }` 同义保留。
            if (typeof body.concise === 'boolean') {
              sendJson(res, 200, { concise: state.setConcise(body.concise === true) })
              return
            }
            if (typeof body.enabled === 'boolean' || body.auto === true || body.auto === false) {
              const armed = state.setArmed(body.enabled === true || body.auto === true)
              sendJson(res, 200, { enabled: armed, auto: armed })
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

  // 控制句柄：测试与诊断要用它读改运行档/armed。宿主忽略返回值即可。
  return { state, config, stats, guardState, taskOf }
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
  return value !== null && typeof value === 'object' && value.reasoningEffort === AUTO_EFFORT_ID
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
    next.config = virtual ? { ...result.config, reasoningEffort: AUTO_EFFORT_ID } : result.config
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
  const result = { sessionId: sessionId ?? null, probes: [] }
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    if (sessions === undefined || typeof sessionId !== 'string') {
      result.error = 'sessions service or session id unavailable'
      return result
    }
    const session = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (session === undefined || session === null) {
      result.error = 'session not found'
      return result
    }
    // 1) 请求头里记录的档位：这一项决定下一次请求带什么。
    try {
      result.header = session.requestHeader?.()?.config ?? null
    } catch (error) {
      result.headerError = String(error?.message ?? error)
    }
    // 2) 会话日志里最后几条 `model/selection`：用户点 Auto 到底有没有落盘。
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      const picks = []
      for (let i = events.length - 1; i >= 0 && picks.length < 5; i -= 1) {
        const event = events[i]
        if (event?.type === 'model/selection') picks.push({ seq: event.seq, data: event.data })
      }
      result.selections = picks.reverse()
    } catch (error) {
      result.selectionError = String(error?.message ?? error)
    }
  } catch (error) {
    result.error = error?.message ?? String(error)
  }
  return result
}
