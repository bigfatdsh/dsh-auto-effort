/**
 * 任务分级：从一次请求里读出"这次要花多少推理"，输出一个档位。
 *
 * ## 为什么必须是纯函数
 *
 * 判断结果直接决定模型被调成什么推理强度，一旦写错就是"简单任务想太久"或者
 * "复杂任务想太浅"，两种都只能靠人肉发现。所以这里不碰 ctx、不碰网络、不读时钟：
 * 输入是消息数组，输出是 `{ tier, score, reason, ... }`，全部可被单测钉死。
 *
 * ## 为什么是规则而不是再调一次模型
 *
 * 再调一次模型来"判断难度"要多花一次往返和一份输入 token，而它要判断的东西
 * 本来就在这条请求里。规则版本是 0 token、0 往返、可预测、可回归测试的；代价是
 * 它只能看懂显式信号（长度、关键词、路径、代码块），看不懂暗示——所以每个档位
 * 都要留好退路：看不懂就停在中间档，不倒向两极。
 *
 * ## 档位与模型能力的关系
 *
 * 档位是"这次任务需要多少推理"，不是"某个模型支持哪个字符串"。把档位落成具体
 * effort id 是 {@link clampEffort} 的事：模型不提供某一档时，往**低**退而不是
 * 往高退（高退会白烧 token，低退最多多想一点）。
 *
 * @module dsh-auto-effort/classify
 */

/** 档位由弱到强的顺序；索引即强度。 */
export const TIERS = ['off', 'low', 'high', 'max']

/** 各档位的目标 effort id，按"最想要"到"次想要"排列。 */
const TIER_PREFERENCE = {
  off: ['off', 'low', 'high', 'max'],
  low: ['low', 'off', 'high', 'max'],
  high: ['high', 'max', 'low', 'off'],
  max: ['max', 'high', 'low', 'off'],
}

/** 分数到档位的边界：`<=` 上界。 */
const THRESHOLDS = [
  { max: 0, tier: 'off' },
  { max: 3, tier: 'low' },
  { max: 8, tier: 'high' },
  { max: Infinity, tier: 'max' },
]

/**
 * 扫描文本的长度上限。
 *
 * 规则所需的信号全部出现在开头与结尾（问候、祈使、路径、要求清单），中段是任务
 * 内容本身——它只通过**长度**影响判断，而长度是单独数的。所以扫描截断到 8k 字符：
 * 一次请求最多扫 16k，成本恒定且可忽略。
 */
export const CLASSIFY_BUDGET_CHARS = 8000
const SCAN_LIMIT = CLASSIFY_BUDGET_CHARS

/** 尾段长度：总结、追问、硬要求通常压在消息最后。 */
const TAIL_LIMIT = 600

// ---------------------------------------------------------------------------
// 信号
// ---------------------------------------------------------------------------

/**
 * 一条信号。
 *
 * `weight` 是它对"任务有多重"的贡献；`floor` 是它对档位的下界（出现即"至少这么重"）。
 * `action` 表示"这条消息在要求动手做事"，用于阻止降到 `off`。
 *
 * @typedef {object} Signal
 * @property {string} id - 稳定标识，出现在 decision.reasons 里。
 * @property {RegExp} pattern - 在截断后的用户文本上测试（`i` 由调用方补）。
 * @property {number} weight - 命中后加到总分上的权重。
 * @property {'off'|'low'|'high'|'max'} [floor] - 命中后的档位下界。
 * @property {boolean} [action] - 是否属于"要求动手"的信号。
 */

/** @type {Signal[]} */
export const SIGNALS = [
  // --- 闲聊 / 纯问答：主动减负，但只减到 low 以下由 action 闸门决定 ---
  {
    id: 'greeting',
    pattern: /^(?:hi|hey|hello|yo|你好|您好|在吗|早上好|下午好|晚上好|嗨|哈喽)[\s!！。.~～?？]*$/i,
    weight: 0,
  },
  { id: 'thanks', pattern: /^(谢谢|多谢|感谢|thanks|thank you|thx|好的|好嘞|收到|ok|okay|嗯|了解)[\s!！。.~～]*$/i, weight: 0 },
  { id: 'casual', pattern: /(聊聊天|随便聊|闲聊|讲个笑话|说个笑话|逗我|无聊|你在干嘛|你是谁|你叫什么|什么模型|几点|天气|股票|汇率|彩票|运势|星座)/i, weight: 0 },

  // --- 事实问答：不需要动手，但需要一点脑子 ---
  {
    id: 'ask-fact',
    pattern: /(是什么|什么是|什么意思|为什么|为何|怎么理解|区别|差异|对比|还是|哪个好|哪个更|能不能|可不可以|是否|会不会|^how |^what |^why |^when |^which |^who |\?|？)/i,
    weight: 1,
  },
  { id: 'explain', pattern: /(解释|说明|介绍|科普|原理|概念|定义|举例|入门|examples?|explain|introduce)/i, weight: 1 },

  // --- 动手做事：一旦出现，禁止降到 off ---
  {
    id: 'imperative',
    pattern: /(帮我|请帮|帮忙|给我|替我|麻烦|帮忙把|写一个|做一个|搞一个|生成|创建|新建|实现|开发|搭建|部署|安装|配置|改造|重构|修复|修一下|调试|排查|定位|找一下|查一下|查查|搜一下|搜索|下载|导出|导入|转换|翻译|整理|汇总|统计|计算|生成一份|出一份|跑一下|运行|执行|测试一下|帮我看看|看看这个|看一下这个)/i,
    weight: 2,
    action: true,
  },
  // 汉语祈使句经常省略主语与"帮我"：`把 X 转成 Y`、`改成`、`存到`、`删掉`。
  // 少了这一类，"把这个文件转成 pdf"会退化成零信号——而这明显是要动手的活。
  {
    id: 'imperative-bare',
    pattern: /(^|[\s，,。;；])(把|将)[^\s]{1,24}(转成|转为|转换成|改成|换成|拆成|分成|整理成|合并成|存到|放到|移到|挪到|发到|复制到|导出到|导入到|删掉|删除|去掉|加上|贴到|贴进|写进|填进|打印|打开|读出|清空|重命名|改名)/i,
    weight: 2,
    action: true,
  },
  {
    id: 'imperative-verb-only',
    pattern: /(转成|转为|转换成|改成|换成|拆成|分成|整理成|合并成|存到|放到|移到|挪到|导出到|导入到|删掉|删除掉|重命名|改名|打印出来|读出来)/i,
    weight: 2,
    action: true,
  },
  { id: 'english-imperative', pattern: /\b(write|create|build|implement|develop|generate|refactor|fix|debug|optimi[sz]e|migrate|deploy|install|configure|convert|translate|summari[sz]e|audit|review|analy[sz]e|extract|parse|benchmark|add|remove|update|change|make|run|test|check)\b/i, weight: 2, action: true },

  // --- 作业类：几乎总是要动文件或动工具 ---
  {
    id: 'artifact',
    pattern: /(word|docx|excel|xlsx|csv|ppt|pptx|slide|slides|markdown|报告|文档|表格|幻灯片|演示文稿|简历|方案|计划书|论文|申请|材料|清单|图表|流程图|思维导图)/i,
    weight: 3,
    floor: 'high',
    action: true,
  },

  // --- 问题信号：不动手也要好好想 ---
  { id: 'problem', pattern: /(bug|报错|错误|崩溃|失败|异常|不生效|没反应|不工作|坏了|卡住|超时|泄漏|死循环|regression|crash|error|exception|fails?|broken|stuck|leak)/i, weight: 2, floor: 'high' },

  // --- 代码与文件：具体对象，出错代价高 ---
  { id: 'code-block', pattern: /```/, weight: 2, floor: 'low' },
  {
    id: 'path',
    pattern: /(\/[\w.@-]+\/[\w.@/-]+|[A-Za-z]:\\\\|\.{1,2}\/|[\w-]+\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|swift|c|h|cpp|rb|php|sh|ps1|sql|json|ya?ml|toml|xml|html|css|scss|md|txt|docx?|xlsx?|pptx?|pdf|zip|png|jpe?g|svg)\b)/i,
    weight: 1,
    floor: 'low',
  },
  { id: 'url', pattern: /https?:\/\/|www\./i, weight: 1, floor: 'low' },
  { id: 'code-term', pattern: /(函数|接口|类|方法|变量|参数|依赖|编译|构建|打包|版本|分支|合并|提交|仓库|代码|脚本|正则|语法|类型|断言|单测|集成测试|性能|并发|内存|线程|进程|缓存|索引|迁移|数据库|表结构|api|sdk|cli|regex|typescript|javascript|python|node|react|vue|http|https|tcp|sql|docker|kubernetes|git|npm|pnpm)/i, weight: 1, floor: 'low' },

  // --- 规模：最可靠的"这次很重"证据 ---
  { id: 'multi-step', pattern: /(第一步|第二步|第三步|首先|其次|然后|接着|最后|step \d|first,|second,|then,|finally,|1\.\s|2\.\s|3\.\s)/i, weight: 2, floor: 'high' },
  { id: 'high-rigor', pattern: /(必须|务必|一定|严格|彻底|完整|全面|详尽|详细|逐条|逐项|逐个|全量|所有|每一个|不要遗漏|不能遗漏|零错误|无错误|上线|生产环境|不能出错|一次到位|exhaustive|thorough|rigorous|complete|all of|every|must not|no errors?|production)/i, weight: 3, floor: 'high' },
  { id: 'audit', pattern: /(审查|审计|评估|复盘|根因|根因分析|风险|安全|合规|架构|重构方案|性能优化|调优|压测|基准测试|code review|audit|security|compliance|architecture|root cause)/i, weight: 2, floor: 'high' },
  { id: 'accumulate', pattern: /(并且|而且|同时|另外|还要|以及|顺便|除此之外|再加|不光|不仅|both|also|plus|as well as)/i, weight: 1 },
  { id: 'explicit-heavy', pattern: /(彻底|极致|穷尽|所有细节|全部细节|最彻底|深入|细致|仔细|认真|一点点|每一处|每一行|反复|多轮|长期|大规模|大批量|整个项目|全项目|整个仓库)/i, weight: 2, floor: 'high' },

  // --- 否定/回避：越是不确定越要多想 ---
  { id: 'uncertainty', pattern: /(不确定|不清楚|不知道|可能|也许|大概|应该是|好像|似乎|猜|why not|not sure|maybe|probably|somehow)/i, weight: 1 },
]

/**
 * "含糊短追问"的规模上限（词数）。
 *
 * 超过这个规模的消息自带足够信号，不需要借用上一轮的档位。
 */
const REFERENT_MAX_WORDS = 40

/**
 * 承接语：表示"接着刚才那件事"。
 *
 * 只有出现在**开头**才算：中文里这些词前置即承接，出现在中间多半是别的话。
 */
const CONTINUATION_PATTERN = /^(继续|接着|然后呢|然后|还有呢|还有|再来|再看看|再看下|再看一眼|下一步|go on|continue|next|and\?|then\?)/i

/**
 * 指代性措辞：靠上下文才成立的说法（"这个/那里/上面那个/刚才那个"）。
 *
 * 命中说明"信息不在这一句里"——要么在附件里，要么在刚才那件事里。
 */
const REFERENT_PATTERN = /(这个|那个|这些|那些|它|他|刚才|上面|上边|前面|之前|刚刚|this|that|it\b|those|these|above|previous)/i

/** floor 的档位序号，避免在热路径上做字符串查表。 */
const FLOOR_INDEX = { off: 0, low: 1, high: 2, max: 3 }

// ---------------------------------------------------------------------------
// 文本提取与计数
// ---------------------------------------------------------------------------

/**
 * 从一条消息的 `content` 里取纯文本。
 *
 * 消息可能来自任何 provider：`content` 是字符串、或内容块数组、或两者都不是。
 * 取不到就返回空串——判断退化成"没有信号"，而不是抛错打断请求。
 *
 * @param {unknown} message - 任意消息对象。
 * @returns {string} 该消息的全部文本（块之间以换行相接）。
 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = /** @type {{ content?: unknown }} */ (message).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const text = /** @type {{ text?: unknown }} */ (block).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 数一份文本的规模：字符数与"词"数。
 *
 * CJK 没有词边界，所以每个 CJK 字符算一个词；其余按空白/标点切分。这个数只用于
 * 分档，不用于计费，因此"够用且确定"比"精确"重要。
 *
 * @param {string} text - 已经截断的文本。
 * @returns {{ chars: number, words: number }} 规模。
 */
export function sizeOf(text) {
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1
  }
  const asciiWords = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu, ' ').split(/[^A-Za-z0-9_+#.-]+/u).filter((word) => word !== '')
  return { chars: text.length, words: cjk + asciiWords.length }
}

/**
 * 取扫描窗口：开头一段 + 结尾一段。
 *
 * @param {string} text - 原始用户文本。
 * @returns {string} 用于正则匹配的窗口。
 */
function scanWindow(text) {
  if (text.length <= SCAN_LIMIT) return text
  return `${text.slice(0, SCAN_LIMIT - TAIL_LIMIT)}\n${text.slice(-TAIL_LIMIT)}`
}

// ---------------------------------------------------------------------------
// 主判定
// ---------------------------------------------------------------------------

/**
 * 一次判定的完整依据。
 *
 * @typedef {object} Decision
 * @property {'off'|'low'|'high'|'max'|null} tier - 本次任务需要的推理档位；续跑请求为 null（不判定）。
 * @property {number} score - 命中信号的总权重。
 * @property {string} reason - 一句话说明，直接进日志与界面提示。
 * @property {string[]} signals - 命中的信号 id，按命中顺序。
 * @property {number} words - 用户消息的词数。
 * @property {number} chars - 用户消息的字符数。
 * @property {number} contextMessages - 参与判断的消息条数。
 * @property {boolean} toolLoop - 是否处于工具结果回灌的续跑请求。
 * @property {number} toolErrors - 尾部工具结果里的错误条数。
 * @property {boolean} inherited - 档位是否来自"上一轮任务进行中"的上下文继承。
 */

/**
 * 判定一次任务该用哪个档位。
 *
 * @param {object} input - 判定输入。
 * @param {readonly unknown[]} input.messages - 请求里的完整消息数组。
 * @param {number} [input.toolCount] - 本次请求暴露给模型的工具数。
 * @param {'off'|'low'|'high'|'max'|null} [input.previousTier] - 本会话**上一轮**判定的档位。
 *   任务进行中（上一轮是 high/max）时，含糊的短追问不再被压低——"把它改成流式"
 *   这种句子本身没有信号，但它的分量由上下文给。
 * @returns {Decision} 判定结果。
 */
export function classify(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : []
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined
  const lastRole = roleOf(last)

  // 续跑请求：末尾是工具结果（或助手的中途发言），说明这一轮的用户意图已经判过，
  // 调用方应当原样放行（继承上一次的 effort）。这里**不给档位**：编一个档位只会让
  // 日志和界面显示一个并没有被使用的数字。
  if (lastRole !== 'user') {
    const { toolErrors } = trailingToolErrors(messages)
    return {
      tier: null,
      score: 0,
      reason: lastRole === 'tool' || lastRole === 'assistant' ? 'continuation' : 'no-user-message',
      signals: [],
      words: 0,
      chars: 0,
      contextMessages: messages.length,
      toolLoop: lastRole === 'tool' || lastRole === 'assistant',
      toolErrors,
      inherited: false,
    }
  }

  const raw = messageText(last)
  const text = scanWindow(raw)
  const { chars, words } = sizeOf(raw)
  const toolCount = Number.isFinite(input?.toolCount) ? Math.max(0, Number(input.toolCount)) : 0

  let score = 0
  let floorIndex = 0
  let action = false
  const signals = []
  for (const signal of SIGNALS) {
    if (!signal.pattern.test(text)) continue
    signals.push(signal.id)
    score += signal.weight
    if (signal.action === true) action = true
    if (signal.floor !== undefined) floorIndex = Math.max(floorIndex, FLOOR_INDEX[signal.floor] ?? 0)
  }

  // 规模本身也是证据：长指令通常意味着多个约束要同时满足。
  if (words >= 60) score += 1
  if (words >= 200) score += 2
  if (words >= 600) score += 3

  // 一屏装不下的输入（长粘贴、长文档）：需要真正读完再答。
  if (chars >= 4000 && signals.includes('code-block')) floorIndex = Math.max(floorIndex, FLOOR_INDEX.low)

  // 最近一段里的工具错误：跨过用户的"还是不行""再试一次"这类回执，仍然算证据。
  // 一次失败说明不了什么，两次以上说明这条任务卡住了。
  const { toolErrors } = recentToolErrors(messages)
  if (toolErrors >= 2) {
    score += 2
    floorIndex = Math.max(floorIndex, FLOOR_INDEX.high)
    signals.push('tool-errors')
  } else if (toolErrors === 1) {
    score += 1
    signals.push('tool-error')
  }

  // 工具表很大（几十个工具）意味着"选哪个工具"本身就是难题；中等规模不加权，
  // 避免所有会话一起上浮。
  if (toolCount >= 24) {
    score += 1
    floorIndex = Math.max(floorIndex, FLOOR_INDEX.low)
    signals.push('many-tools')
  }

  // 整条消息就是一句问候：无论它带没带问号，都不该按"提问"加权——"在吗？"不是问题，
  // 它是敲门。但工具表很大时上面已经抬了下界，那种情况不按问候处理。
  if (signals.includes('greeting') && !action && floorIndex === 0) {
    return finish('off', 0, 'greeting', ['greeting'], { words, chars, messages, toolErrors })
  }

  // 含糊的短追问：这一句自己几乎没有信号，但任务正在跑。判低了会让模型在
  // 已经开始的活上突然变浅；判高了又会让"谢谢"这种收尾继续烧钱。
  //
  // 于是只在三条同时成立时才继承上一轮的档位：
  //   1. 上一轮判为 high/max（任务确实在进行）；
  //   2. 这条消息足够短（长消息自带信号，不需要借）；
  //   3. 它不是问候/闲聊/收尾（那几类有专门的信号，不该被上下文拉高）。
  const previousTier = input?.previousTier
  const previousIndex = typeof previousTier === 'string' ? TIERS.indexOf(previousTier) : -1
  const casual = signals.some((id) => id === 'greeting' || id === 'thanks' || id === 'casual')
  const referent = REFERENT_PATTERN.test(text)
  const continuation = CONTINUATION_PATTERN.test(text)
  const inherit = previousIndex >= 2 && words <= REFERENT_MAX_WORDS && !casual && (referent || continuation)
  if (inherit) {
    floorIndex = Math.max(floorIndex, previousIndex)
    signals.push(referent ? 'referent-inherit' : 'continuation-inherit')
  }

  let tier = tierFor(score)
  if (TIERS.indexOf(tier) < floorIndex) tier = /** @type {'off'|'low'|'high'|'max'} */ (TIERS[floorIndex])
  // 要求动手做事时不降到 off：off 会同时关掉思考与工具前的判断，省下的那点
  // token 换不来一次返工。
  if (tier === 'off' && action) tier = 'low'

  return finish(tier, score, signals.length > 0 ? signals.join('+') : 'no-signal', signals, {
    words,
    chars,
    messages,
    toolErrors,
  })
}

/**
 * 组装一条判定结果。
 *
 * @param {'off'|'low'|'high'|'max'} tier - 档位。
 * @param {number} score - 命中权重。
 * @param {string} reason - 一句话说明。
 * @param {string[]} signals - 命中信号。
 * @param {{words: number, chars: number, messages: readonly unknown[], toolErrors: number}} facts - 规模与上下文事实。
 * @returns {Decision} 判定结果。
 */
function finish(tier, score, reason, signals, facts) {
  return {
    tier,
    score,
    reason,
    signals,
    inherited: signals.includes('referent-inherit') || signals.includes('continuation-inherit'),
    words: facts.words,
    chars: facts.chars,
    contextMessages: facts.messages.length,
    toolLoop: false,
    toolErrors: facts.toolErrors,
  }
}

/**
 * @param {unknown} message - 任意消息。
 * @returns {string} 小写 role，读不到返回空串。
 */
function roleOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const role = /** @type {{ role?: unknown }} */ (message).role
  return typeof role === 'string' ? role.toLowerCase() : ''
}

/**
 * 统计尾部连续工具结果里的错误条数。
 *
 * 只数**尾部连续**的那一段：更早的工具结果属于已经翻过去的步骤。这里只用于
 * "这条请求是不是续跑"和日志，不直接参与打分。
 *
 * @param {readonly unknown[]} messages - 完整消息数组。
 * @returns {{ toolErrors: number, toolMessages: number }} 统计结果。
 */
export function trailingToolErrors(messages) {
  let toolErrors = 0
  let toolMessages = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const role = roleOf(message)
    if (role === 'user') break
    if (role !== 'tool') continue
    toolMessages += 1
    if (/** @type {{ isError?: unknown }} */ (message).isError === true) toolErrors += 1
    if (toolMessages >= 12) break
  }
  return { toolErrors, toolMessages }
}

/**
 * 统计"最后一条用户消息之前"那一段里的工具错误。
 *
 * 用户重说一遍时通常不会复述报错内容——"还是不行""再试一次"就是全部信息。所以
 * 证据要从他**上一句**所在的位置往回看：一条报错说明这次不顺，两条以上说明这条
 * 任务真的卡住了，那正是该多想的时候。
 *
 * 窗口按消息条数封顶（默认 10 条），更早的失败属于已经翻过去的步骤；把它们算进
 * 来会让一次偶发失败把整段会话顶到高档位。
 *
 * @param {readonly unknown[]} messages - 完整消息数组。
 * @param {number} [budget] - 向前查看的消息条数上限。
 * @returns {{ toolErrors: number, toolMessages: number }} 统计结果。
 */
export function recentToolErrors(messages, budget = 10) {
  let toolErrors = 0
  let toolMessages = 0
  let seen = 0
  for (let index = messages.length - 1; index >= 0 && seen < budget; index -= 1) {
    const message = messages[index]
    const role = roleOf(message)
    if (role === 'user') {
      // 跳过最后一条用户消息本身，继续往前看它之前发生了什么。
      if (seen === 0 && index === messages.length - 1) continue
      break
    }
    seen += 1
    if (role !== 'tool') continue
    toolMessages += 1
    if (/** @type {{ isError?: unknown }} */ (message).isError === true) toolErrors += 1
  }
  return { toolErrors, toolMessages }
}

/**
 * @param {number} score - 命中权重之和。
 * @returns {'off'|'low'|'high'|'max'} 对应档位。
 */
function tierFor(score) {
  for (const step of THRESHOLDS) {
    if (score <= step.max) return step.tier
  }
  return 'max'
}

/**
 * 把档位落成一个该模型真的支持的 effort id。
 *
 * 规则有四条，顺序不能换：
 * 1. **模型声明了什么就用什么**：不认识的 id 一律不猜。
 * 2. **请求上已有的强度是下界**：它只可能来自用户的显式选择（模型自己的默认档由
 *    provider 在解析请求时补齐，不出现在请求对象上），所以"不越过用户选的值"。
 * 3. **floor/ceiling 配置是硬边界**。
 * 4. **目标档位不存在时取档位距离最近的**（真实例子：只有 off/low 的模型被判定需要
 *    high 时给 low），平手取更强的那个——想多一点比想少一点安全。
 *
 * @param {object} input - 解析输入。
 * @param {'off'|'low'|'high'|'max'|string} input.tier - 目标档位。
 * @param {readonly (string|{id?: unknown})[]} [input.efforts] - 模型声明的 effort 列表。
 * @param {string} [input.defaultEffort] - 模型自己的默认 effort。
 * @param {string} [input.observedEffort] - 请求上已有的 effort（只会是用户的显式选择）。
 * @param {string} [input.effortFloor] - 下界：`adapter-default`/`observed`/`off`/`low`/`high`/`max`。
 * @param {string} [input.effortCeiling] - 上界：`adapter-default`/`off`/`low`/`high`/`max`；缺省即无上界。
 * @param {string} [input.effortId] - 判定结果对应的 effort id（默认 `auto`）：模型目录里
 *   已经带上这个虚拟档位时直接用它，不需要在物理档位里找近似值。
 * @returns {string|undefined} 可用的 effort id；模型没有可用档位时返回 undefined。
 */
export function clampEffort(input) {
  const available = normalizeEfforts(input?.efforts)
  if (available.length === 0) return undefined

  const rank = (id) => TIERS.indexOf(id)
  const wanted = typeof input?.tier === 'string' ? input.tier : 'high'
  // 判定结果在模型目录里以哪个 id 出现（本插件往选择器里加的虚拟档位）。
  const claimed = typeof input?.effortId === 'string' && input.effortId !== '' ? input.effortId : 'auto'

  const floor = resolveFloor(input?.effortFloor, input?.defaultEffort, input?.observedEffort, rank, available)
  const ceiling = resolveBound(input?.effortCeiling, input?.defaultEffort, rank, available)

  let target = wanted
  if (rank(target) < 0) target = 'high'
  if (floor !== undefined && rank(target) < rank(floor)) target = floor
  if (ceiling !== undefined && rank(target) > rank(ceiling)) target = ceiling

  const ordered = available.slice().sort((a, b) => rank(b) - rank(a))
  // 模型目录已经带上了那个虚拟档位时，判定值就是它——这时不需要在物理档位里找近似值。
  const exact = ordered.find((id) => id === target || id === claimed)
  if (exact !== undefined) return exact

  // 目标档位这个模型没有（真实例子：DeepSeek 只有 off/low/high/max，某些模型只有
  // off/high）。取**档位距离最近**的一个，平手时取更强的那个——相邻档在语义上等价，
  // 想多一点比想少一点安全。
  const targetRank = rank(target)
  let best
  let bestDistance = Infinity
  for (const id of ordered) {
    const idRank = rank(id)
    if (idRank < 0) continue
    const distance = Math.abs(idRank - targetRank)
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && idRank > rank(best))) {
      best = id
      bestDistance = distance
    }
  }
  if (best !== undefined) return best
  // 模型声明的全是本插件不认识的 id：只能照它给的最强档用，绝不自己编一个。
  return ordered[0]
}

/**
 * 解析下界。
 *
 * - 具体档位（`off`/`low`/`high`/`max`）：直接就是下界。
 * - `observed`：以请求上已有的强度为界——用户显式选过的值。
 * - `adapter-default`（默认）：以模型自己的默认档为界，且**同时**不低于用户显式选过的
 *   值。两条合起来就是"只升不降"：自动判定可以把简单任务降下来，但不会越过用户已经
 *   表达过的强度偏好。
 *
 * @param {unknown} value - 配置值。
 * @param {unknown} defaultEffort - 模型默认 effort。
 * @param {unknown} observedEffort - 请求上已有的 effort。
 * @param {(id: string) => number} rank - 档位序号。
 * @param {readonly string[]} available - 模型可用 effort。
 * @returns {string|undefined} 下界 effort，或 undefined。
 */
function resolveFloor(value, defaultEffort, observedEffort, rank, available) {
  const declared = typeof value === 'string' && value !== '' ? value : 'off'
  if (declared === 'off') return undefined
  const concrete = (candidate) =>
    typeof candidate === 'string' && rank(candidate) >= 0 && available.includes(candidate) ? candidate : undefined
  if (declared !== 'adapter-default' && declared !== 'observed') return concrete(declared)
  const observed = concrete(observedEffort)
  if (declared === 'observed') return observed
  const adapter = concrete(defaultEffort)
  if (adapter === undefined) return observed
  if (observed === undefined) return adapter
  return rank(observed) >= rank(adapter) ? observed : adapter
}

/**
 * 解析上界。
 *
 * 空值（没配）表示**没有上界**，而不是"以模型默认为界"：模型默认档不是用户偏好，
 * 拿它当上限会把"这次任务确实需要 max"的判定压回去。要那个语义就显式写
 * `adapter-default`。
 *
 * @param {unknown} value - 配置值。
 * @param {unknown} defaultEffort - 模型默认 effort。
 * @param {(id: string) => number} rank - 档位序号。
 * @param {readonly string[]} available - 模型可用 effort。
 * @returns {string|undefined} 上界 effort，或 undefined。
 */
function resolveBound(value, defaultEffort, rank, available) {
  const declared = typeof value === 'string' && value !== '' ? value : undefined
  if (declared === undefined) return undefined
  if (declared !== 'adapter-default') return rank(declared) >= 0 && available.includes(declared) ? declared : undefined
  if (typeof defaultEffort !== 'string' || rank(defaultEffort) < 0) return undefined
  return available.includes(defaultEffort) ? defaultEffort : undefined
}

/**
 * 把模型声明的 effort 列表规范化成 id 数组。
 *
 * @param {unknown} efforts - 模型元数据里的 `reasoning.efforts`。
 * @returns {string[]} 去重后的 id 列表。
 */
export function normalizeEfforts(efforts) {
  if (!Array.isArray(efforts)) return []
  const ids = []
  for (const entry of efforts) {
    const id = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? entry.id : undefined
    if (typeof id !== 'string' || id === '' || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

/**
 * 档位偏好表：给测试与文档用。
 *
 * @param {'off'|'low'|'high'|'max'} tier - 档位。
 * @returns {string[]} 该档位的偏好顺序。
 */
export function preferenceFor(tier) {
  return TIER_PREFERENCE[tier] ?? TIER_PREFERENCE.high
}
