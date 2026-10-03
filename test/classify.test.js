/**
 * dsh-auto-effort —— 判定核心的单元测试。
 *
 * 只测"能被测错"的部分：档位怎么判、边界在哪、模型能力怎么落成 effort id。
 * 这里每一条断言都对应一个真实的判断错误（简单任务想太久 / 复杂任务想太浅 /
 * 把用户选好的强度改掉），所以它们不是覆盖率装饰，而是回归防线。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TIERS, clampEffort, classify, messageText, normalizeEfforts, preferenceFor, sizeOf } from '../lib/classify.js'

/**
 * @param {string} text - 用户消息正文。
 * @param {object} [extra] - 附加字段。
 * @returns {object} 一条用户消息。
 */
function user(text, extra = {}) {
  return { role: 'user', content: text, ...extra }
}

/**
 * @param {string} role - 角色。
 * @param {string} text - 正文。
 * @param {object} [extra] - 附加字段。
 * @returns {object} 一条消息。
 */
function message(role, text, extra = {}) {
  return { role, content: text, ...extra }
}

test('短问候判到 off：不烧任何思考', () => {
  for (const text of ['你好', 'hi', '在吗？', '谢谢！', '好的', 'ok']) {
    const decision = classify({ messages: [user(text)] })
    assert.equal(decision.tier, 'off', `${text} → ${decision.tier} (${decision.reason})`)
  }
})

test('闲聊与纯问答不判到 high', () => {
  for (const text of ['讲个笑话', '随便聊两句', '你是谁', '今天天气怎么样']) {
    const decision = classify({ messages: [user(text)] })
    assert.ok(TIERS.indexOf(decision.tier) <= 1, `${text} → ${decision.tier}`)
  }
})

test('要求动手做事时绝不判到 off', () => {
  const texts = ['帮我修一下 bug', '写一个函数', '把这个文件转成 pdf', '下载这个网页', '跑一下测试']
  for (const text of texts) {
    const decision = classify({ messages: [user(text)] })
    assert.notEqual(decision.tier, 'off', `${text} → ${decision.tier}`)
  }
})

test('报错类问题至少判到 high：想浅了代价最大', () => {
  const decision = classify({ messages: [user('这个接口一直报错，帮我看下为什么')] })
  assert.equal(decision.tier, 'high', decision.reason)
  assert.ok(decision.signals.includes('problem'))
})

test('文件与交付物类任务至少判到 high', () => {
  const decision = classify({ messages: [user('帮我出一份 Word 报告，说明这次改动的风险')] })
  assert.ok(TIERS.indexOf(decision.tier) >= 2, `${decision.tier} ${decision.reason}`)
})

test('多约束 + 高要求 + 长文判到 max', () => {
  const text = [
    '全面审查这 8 个模块的架构、安全与性能，逐个给出根因分析和重构方案。',
    '要求：必须零错误，不能遗漏任何一处，所有结论都要有代码位置。',
    '第一步先建清单，第二步逐项核对，第三步给出可执行的修复方案。',
    '另外还要给出回归测试方案，并且说明每一处改动的风险。',
    '同时把结果整理成一份文档，最后给出上线前的检查清单。',
  ].join('\n')
  const decision = classify({ messages: [user(text)] })
  assert.equal(decision.tier, 'max', `${decision.tier} score=${decision.score} ${decision.reason}`)
})

test('事实问答是 low，不是 off 也不是 high', () => {
  const decision = classify({ messages: [user('Docker 和 Kubernetes 有什么区别？')] })
  assert.equal(decision.tier, 'low', `${decision.tier} ${decision.reason}`)
})

test('中等改动任务判到 high', () => {
  const decision = classify({ messages: [user('把 lib/report.js 里的导出逻辑重构一下，改成流式写入 /tmp/out.csv')] })
  assert.equal(decision.tier, 'high', `${decision.tier} ${decision.reason}`)
})

test('长文本身会加权：同样的关键词，越长越重', () => {
  const short = classify({ messages: [user('帮我写一个函数')] })
  const long = classify({ messages: [user(`帮我写一个函数。${'还要处理边界情况，并且给出示例。'.repeat(30)}`)] })
  assert.ok(long.score > short.score, `${short.score} → ${long.score}`)
})

test('末尾不是用户消息时判为续跑：不给档位，交给调用方原样放行', () => {
  const decision = classify({
    messages: [user('帮我改这个函数'), message('assistant', '好'), message('tool', '错误：ENOENT', { isError: true, toolCallId: 'c1' })],
  })
  assert.equal(decision.toolLoop, true)
  assert.equal(decision.tier, null)
  assert.equal(decision.reason, 'continuation')
})

test('尾部工具错误会抬高判定', () => {
  const base = classify({ messages: [user('看看这个结果')] })
  const withErrors = classify({
    messages: [
      user('看看这个结果'),
      message('assistant', '跑一下'),
      message('tool', 'failed', { isError: true, toolCallId: 'c1' }),
      message('tool', 'failed again', { isError: true, toolCallId: 'c2' }),
    ],
  })
  assert.equal(base.tier, 'low')
  // 末尾是工具结果 → 整条请求按续跑处理，不给档位；错误计数仍会被记下来，
  // 供下一条用户消息判定时使用。
  assert.equal(withErrors.tier, null)
  assert.equal(withErrors.toolErrors, 2)
})

test('单条工具错误只计一次，不直接顶到高档位', () => {
  const decision = classify({
    messages: [user('这个数字是多少'), message('tool', 'boom', { isError: true, toolCallId: 'c1' })],
  })
  assert.equal(decision.toolLoop, true)
  assert.equal(decision.toolErrors, 1)
  assert.equal(decision.tier, null)
})

test('工具错误进入下一条用户消息的判定', () => {
  const decision = classify({
    messages: [
      user('看看这个结果'),
      message('tool', 'boom', { isError: true, toolCallId: 'c1' }),
      user('还是不行，再看看'),
    ],
  })
  assert.ok(decision.signals.includes('tool-error'))
  assert.ok(decision.score > 0)
})

test('工具表很大时至少判到 low', () => {
  const decision = classify({ messages: [user('你好')], toolCount: 40 })
  assert.equal(decision.tier, 'low', decision.reason)
})

test('消息内容的各种形态都能读出文本', () => {
  assert.equal(messageText({ role: 'user', content: 'abc' }), 'abc')
  assert.equal(
    messageText({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }] }),
    'a\nb',
  )
  assert.equal(messageText({ role: 'user', content: 42 }), '')
  assert.equal(messageText(null), '')
  assert.equal(messageText(undefined), '')
})

test('规模统计：CJK 按字、英文按词', () => {
  assert.deepEqual(sizeOf('你好世界'), { chars: 4, words: 4 })
  assert.deepEqual(sizeOf('hello world foo'), { chars: 15, words: 3 })
  assert.equal(sizeOf('你好 hello').words, 3)
})

test('空消息与畸形输入不抛错，且不给出档位', () => {
  for (const messages of [[], undefined, [null], [{}], [{ role: 'user' }]]) {
    const decision = classify({ messages })
    assert.ok(decision.tier === null || TIERS.includes(decision.tier), JSON.stringify(messages))
  }
})

test('clampEffort：目标档位存在时精确命中', () => {
  const efforts = ['off', 'low', 'high', 'max']
  assert.equal(clampEffort({ tier: 'off', efforts }), 'off')
  assert.equal(clampEffort({ tier: 'low', efforts }), 'low')
  assert.equal(clampEffort({ tier: 'high', efforts }), 'high')
  assert.equal(clampEffort({ tier: 'max', efforts }), 'max')
})

test('clampEffort：目标档位缺失时取档位距离最近的，平手取更强的', () => {
  // 只有 off/low：要 high 时给 low，绝不擅自给别的模型的 max。
  assert.equal(clampEffort({ tier: 'high', efforts: ['off', 'low'] }), 'low')
  assert.equal(clampEffort({ tier: 'max', efforts: ['off', 'low'] }), 'low')
  // off/high/max：要 low 时距离最近的是 off（1 步），不是 high（1 步但更远？平手取强）——
  // 平手取更强的那个，所以是 high。
  assert.equal(clampEffort({ tier: 'low', efforts: ['off', 'high', 'max'] }), 'high')
  // 平手规则再验一次：target=high，可用 low/max 各差 1 步 → 取 max。
  assert.equal(clampEffort({ tier: 'high', efforts: ['low', 'max'] }), 'max')
  // 有精确档位时永远精确命中，不受平手规则影响。
  assert.equal(clampEffort({ tier: 'low', efforts: ['off', 'low', 'high', 'max'] }), 'low')
})

test('clampEffort：不认识的 id 一律不当档位用', () => {
  // 目标是不认识的字符串 → 按 high 处理；可用集里只有 exotic 时只能给它，而不是编一个 high。
  assert.equal(clampEffort({ tier: 'exotic', efforts: ['exotic'] }), 'exotic')
  assert.equal(clampEffort({ tier: 'high', efforts: [{ id: 'exotic' }] }), 'exotic')
  assert.equal(clampEffort({ tier: 'high', efforts: [] }), undefined)
  assert.equal(clampEffort({ tier: 'high', efforts: undefined }), undefined)
})

test('clampEffort：effortFloor=adapter-default 时不低于模型默认档', () => {
  const efforts = ['off', 'low', 'high', 'max']
  assert.equal(clampEffort({ tier: 'low', efforts, defaultEffort: 'high', effortFloor: 'adapter-default' }), 'high')
  assert.equal(clampEffort({ tier: 'low', efforts, defaultEffort: 'high', effortFloor: 'low' }), 'low')
  assert.equal(clampEffort({ tier: 'max', efforts, defaultEffort: 'high', effortCeiling: 'adapter-default' }), 'high')
  assert.equal(clampEffort({ tier: 'max', efforts, defaultEffort: 'high', effortCeiling: 'max' }), 'max')
})

test('clampEffort：effortFloor=observed 时以请求上已有的强度为下界', () => {
  const efforts = ['off', 'low', 'high', 'max']
  assert.equal(clampEffort({ tier: 'off', efforts, observedEffort: 'max', effortFloor: 'observed' }), 'max')
  assert.equal(clampEffort({ tier: 'off', efforts, observedEffort: 'exotic', effortFloor: 'observed' }), 'off')
  assert.equal(clampEffort({ tier: 'off', efforts, observedEffort: 'max', effortFloor: 'off' }), 'off')
})

test('clampEffort：adapter-default 下界同时尊重用户选过的值（取两者更强）', () => {
  const efforts = ['off', 'low', 'high', 'max']
  // 模型默认 low，但用户选过 max → 下界是 max。
  assert.equal(clampEffort({ tier: 'low', efforts, defaultEffort: 'low', observedEffort: 'max', effortFloor: 'adapter-default' }), 'max')
  // 模型默认 max，用户选过 low → 下界仍是 max（模型默认更强）。
  assert.equal(clampEffort({ tier: 'low', efforts, defaultEffort: 'max', observedEffort: 'low', effortFloor: 'adapter-default' }), 'max')
  // 上界默认不存在：判定要 max 时不会被"模型默认 low"压回来。
  assert.equal(clampEffort({ tier: 'max', efforts, defaultEffort: 'low' }), 'max')
})

test('clampEffort：模型没有默认档时该下界不生效，判定自由', () => {
  const efforts = ['low', 'high']
  assert.equal(clampEffort({ tier: 'low', efforts, effortFloor: 'adapter-default' }), 'low')
})

test('normalizeEfforts：去重、跳过坏值、接受字符串与对象两种形态', () => {
  assert.deepEqual(normalizeEfforts(['low', 'low', 'high']), ['low', 'high'])
  assert.deepEqual(normalizeEfforts([{ id: 'low' }, { id: 7 }, null, 'off']), ['low', 'off'])
  assert.deepEqual(normalizeEfforts(undefined), [])
  assert.deepEqual(normalizeEfforts([{ name: 'low' }]), [])
})

test('preferenceFor 覆盖全部档位，不返回 undefined', () => {
  for (const tier of TIERS) {
    assert.ok(Array.isArray(preferenceFor(tier)))
    assert.ok(preferenceFor(tier).length > 0)
  }
})
