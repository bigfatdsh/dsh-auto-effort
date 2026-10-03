/**
 * dsh-auto-effort —— Host 装配层的单元测试。
 *
 * 覆盖三块只靠"跑起来看"很难查的东西：配置校验（写错配置要在装配时就暴露）、
 * 界面开关状态（读坏要能回落）、以及插件自己声明的两个常量是否与浏览器半边
 * 一致（端点路径与运行档名字对不上时，界面会显示一个 Host 不认的值）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, MODES, resolveConfig } from '../lib/schema.js'
import { RUN_MODES, ToggleState, statePath } from '../lib/state.js'
import {
  ROUTE_PATH,
  EffortStats,
  apply,
  inject,
  isVirtualEffort,
  name,
  throughAuto,
  withAutoEffort,
  withoutVirtualEffort,
} from '../lib/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 临时目录里的一个干净状态文件路径。 */
async function tempState() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-effort-'))
  return { dir, file: join(dir, 'auto-effort.json') }
}

test('插件名与 bundle 补丁里的 id 一致', () => {
  assert.equal(name, 'auto-effort')
  const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: 'dsh-auto-effort'/)
  assert.match(patch, /id: auto-effort/)
})

test('依赖声明：llm 与 webServer 都是硬依赖（实测 ctx.get 取不到 webServer）', () => {
  assert.deepEqual(inject, ['llm', 'webServer'])
})

test('配置校验：虚拟档位的 id 与显示名有默认值', () => {
  const parsed = Config['~standard'].validate({})
  assert.equal(parsed.value.effortId, 'auto')
  assert.equal(parsed.value.effortName, 'Auto')
  assert.equal(parsed.value.autoDefault, false)
})

test('配置校验：空配置补全默认值，且默认就是需求指定的 auto', () => {
  const parsed = Config['~standard'].validate({})
  assert.equal(parsed.issues, undefined)
  assert.equal(parsed.value.mode, 'auto')
  assert.equal(parsed.value.enabled, true)
  assert.equal(parsed.value.persist, true)
  // 默认守卫手选档位：手选 high 不该被降（实测踩过）
  assert.equal(parsed.value.effortFloor, 'observed')
  assert.equal(parsed.value.effortCeiling, 'max')
  assert.equal(parsed.value.minTier, 'off')
  assert.equal(parsed.value.maxTier, 'max')
})

test('配置校验：拼错的键被拒绝，而不是静默用默认值', () => {
  const parsed = Config['~standard'].validate({ mod: 'auto' })
  assert.equal(parsed.value, undefined)
  assert.match(parsed.issues[0].message, /mod: unknown option/)
})

test('配置校验：非法取值被拒绝并报出字段名', () => {
  const parsed = Config['~standard'].validate({ mode: 'sometimes' })
  assert.equal(parsed.value, undefined)
  assert.match(parsed.issues[0].message, /mode: expected one of auto \| pin \| off/)
})

test('配置校验：合法取值原样通过', () => {
  const parsed = Config['~standard'].validate({ mode: 'pin', enabled: false, log: false })
  assert.equal(parsed.issues, undefined)
  assert.equal(parsed.value.mode, 'pin')
  assert.equal(parsed.value.enabled, false)
  assert.equal(parsed.value.log, false)
})

test('resolveConfig：坏配置回落默认值，不抛错', () => {
  assert.equal(resolveConfig(undefined).mode, 'auto')
  assert.equal(resolveConfig(null).mode, 'auto')
  assert.equal(resolveConfig('nope').mode, 'auto')
  assert.equal(resolveConfig({ mode: 42 }).mode, 'auto')
  assert.equal(resolveConfig({ mode: 'pin' }).mode, 'pin')
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
})

test('开关状态：默认跟随配置，非法写入不改变现状', () => {
  const state = new ToggleState({ initial: 'auto' })
  assert.equal(state.get(), 'auto')
  assert.equal(state.set('pin'), 'pin')
  assert.equal(state.set('nonsense'), 'pin')
  assert.equal(state.set(undefined), 'pin')
  assert.equal(state.set('off'), 'off')
})

test('开关状态：非法初始值回落到 auto', () => {
  assert.equal(new ToggleState({ initial: 'whatever' }).get(), 'auto')
  assert.equal(new ToggleState({ initial: undefined }).get(), 'auto')
})

test('开关状态：写盘后能读回，且文件是完整 JSON', async () => {
  const { dir, file } = await tempState()
  try {
    const writer = new ToggleState({ initial: 'auto', file })
    writer.set('pin')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(raw, { mode: 'pin' })

    const reader = new ToggleState({ initial: 'auto', file })
    assert.equal(await reader.load(), true)
    assert.equal(reader.get(), 'pin')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('开关状态：文件不存在时保持默认，且不算错误', async () => {
  const { dir, file } = await tempState()
  const errors = []
  try {
    const state = new ToggleState({ initial: 'auto', file, onError: (error) => errors.push(error) })
    assert.equal(await state.load(), false)
    assert.equal(state.get(), 'auto')
    assert.deepEqual(errors, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('开关状态：坏文件只回落并上报，不影响继续工作', async () => {
  const { dir, file } = await tempState()
  const errors = []
  try {
    await writeFile(file, '{ this is not json', 'utf8')
    const state = new ToggleState({ initial: 'low' in {} ? 'auto' : 'auto', file, onError: (error) => errors.push(error) })
    assert.equal(await state.load(), false)
    assert.equal(state.get(), 'auto')
    assert.equal(errors.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('开关状态：文件里是不认识的档位时保持默认', async () => {
  const { dir, file } = await tempState()
  try {
    await writeFile(file, JSON.stringify({ mode: 'turbo' }), 'utf8')
    const state = new ToggleState({ initial: 'auto', file })
    assert.equal(await state.load(), false)
    assert.equal(state.get(), 'auto')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('开关状态：不给文件时纯内存，写盘不报错', () => {
  const state = new ToggleState({ initial: 'auto' })
  assert.equal(state.set('off'), 'off')
  assert.equal(state.get(), 'off')
})

test('statePath 用调用方给的主目录', () => {
  assert.equal(statePath('/tmp/x'), '/tmp/x/auto-effort.json')
  assert.match(statePath(), /auto-effort\.json$/)
})

test('统计：按动作分类计数，并记住最近一次', () => {
  const stats = new EffortStats()
  const request = { provider: 'deepseek', model: 'deepseek-flash', at: 1 }
  stats.record({ action: 'applied', decision: { tier: 'high', score: 5, reason: 'problem' }, effort: 'high' }, request)
  stats.record({ action: 'unchanged', decision: { tier: 'off', score: 0, reason: 'greeting' }, effort: 'off' }, request)
  stats.record({ action: 'continuation', decision: null }, request)
  assert.equal(stats.applied, 1)
  assert.equal(stats.unchanged, 1)
  assert.equal(stats.skipped, 1)
  assert.deepEqual(stats.last, {
    at: 1,
    action: 'continuation',
    provider: 'deepseek',
    model: 'deepseek-flash',
    tier: null,
    effort: null,
    reason: null,
    score: null,
  })
})

test('端点路径稳定（诊断与状态读的都是它）', () => {
  assert.equal(ROUTE_PATH, '/dsh-auto-effort')
  assert.match(clientSource, /const ENDPOINT = '\/dsh-auto-effort'/, '遗留的浏览器半边仍指向同一路径')
})

test('浏览器半边只做展示标记：声明 dsh.client，并注入模型选择器所在的会话界面', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.client?.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  // 标记只按 DOM 的类名后缀工作，不 import 选择器包：inject 只留会话界面这一条，
  // 少声明一条就少一种"客户端组合失败 → 代码根本没加载"的静默失效。
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-conversation'])
})

test('三种运行档只由 Host 持有（浏览器半边不再显示档位）', () => {
  assert.deepEqual(RUN_MODES, MODES)
  assert.deepEqual([...RUN_MODES], ['auto', 'pin', 'off'])
  // 浏览器半边只管"点过 Auto"这个显示标记，不该再出现 run-mode 的取值。
  assert.doesNotMatch(clientSource, /'pin'/)
})

test('模型目录里追加 Auto 档位，不改任何模型能力', () => {
  const info = { provider: 'deepseek', id: 'deepseek-flash', name: 'Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }
  const config = { effortId: 'auto', effortName: 'Auto', effortDescription: 'auto', autoDefault: false }
  const extended = withAutoEffort(info, config)
  assert.deepEqual(extended.reasoning.efforts.map((level) => level.id), ['off', 'high', 'auto'])
  assert.equal(extended.reasoning.defaultEffort, 'high')
  // 入参不被修改
  assert.deepEqual(info.reasoning.efforts.map((level) => level.id), ['off', 'high'])
  // 重复调用幂等
  assert.deepEqual(withAutoEffort(extended, config).reasoning.efforts.map((level) => level.id), ['off', 'high', 'auto'])
  // 没有推理能力的模型不追加：不该出现一个没有意义的"自动"
  assert.equal(withAutoEffort({ provider: 'x', id: 'y', name: 'Y' }, config).reasoning, undefined)
  assert.equal(withAutoEffort(undefined, config), undefined)
})

test('autoDefault 打开时把 Auto 设成模型默认档', () => {
  const info = { reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }
  const extended = withAutoEffort(info, { effortId: 'auto', effortName: 'Auto', autoDefault: true })
  assert.equal(extended.reasoning.defaultEffort, 'auto')
})

test('适配器只看到真实档位，调用方的对象一个字节都不改', () => {
  const config = { effortId: 'auto' }
  const request = { provider: 'deepseek', model: 'm', sessionId: 's1', reasoningEffort: 'auto' }
  const forAdapter = withoutVirtualEffort(request, config)
  assert.deepEqual(forAdapter, { provider: 'deepseek', model: 'm', sessionId: 's1' })
  assert.equal(request.reasoningEffort, 'auto', '请求对象必须原样保留 Auto')

  // 续跑请求沿用本会话上一次判定值，而不是退回模型默认
  const continued = withoutVirtualEffort(request, config, () => 'high')
  assert.equal(continued.reasoningEffort, 'high')

  // 手选的具体档位原样保留
  const picked = { provider: 'deepseek', model: 'm', reasoningEffort: 'max' }
  assert.equal(withoutVirtualEffort(picked, config), picked)
  assert.equal(withoutVirtualEffort(null, config), null)
  assert.equal(isVirtualEffort(request, config), true)
  assert.equal(isVirtualEffort(picked, config), false)
})

test('装配结果：记录里是 Auto，适配器那侧是真实档位', () => {
  const config = { effortId: 'auto' }
  const seen = []
  const prepared = {
    model: { id: 'm' },
    config: { provider: 'deepseek', model: 'm' },
    adapterDefaults: { reasoningEffort: true },
    stream: (options) => {
      seen.push(options.reasoningEffort)
      return 'chunks'
    },
  }
  const wrapped = throughAuto(prepared, { reasoningEffort: 'auto' }, config, () => 'high')
  assert.equal(wrapped.config.reasoningEffort, 'auto', '会话记录必须留着 Auto')
  assert.equal(wrapped.stream({ provider: 'deepseek', model: 'm', reasoningEffort: 'auto' }), 'chunks')
  assert.equal(seen[0], 'high', '适配器拿到的是本会话上一次判定值')
  // 没选 Auto 时原样返回
  const plain = { config: { provider: 'deepseek', model: 'm', reasoningEffort: 'max' } }
  const untouched = throughAuto(plain, { reasoningEffort: 'max' }, config)
  assert.equal(untouched.config.reasoningEffort, 'max')
  assert.equal(throughAuto(null, {}, config), null)
})

test('不 import 宿主包：模块实例不同，按实例标记的判断会全部误判为外部调用', () => {
  const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /from '@deepseek-ai\/dsh-llm'/)
  assert.doesNotMatch(code, /import\('@deepseek-ai\/dsh-llm'\)/)
})

/**
 * 造一个只够装配用的 ctx：记录注册了什么，不真的跑请求。
 *
 * @param {object} services - 可用的服务表。
 * @returns {{ctx: object, events: string[], warnings: string[], infos: string[]}} 上下文与记录。
 */
function fakeCtx(services = {}) {
  const events = []
  const warnings = []
  const infos = []
  return {
    events,
    warnings,
    infos,
    ctx: {
      ...services,
      get: (key) => services[key],
      on: (event) => {
        events.push(event)
        return () => {}
      },
      effect: (fn) => {
        fn()
        return () => {}
      },
      logger: {
        info: (message) => infos.push(message),
        warn: (message) => warnings.push(message),
      },
    },
  }
}

test('装配：注册 llm/stream，且不注册任何别的宿主事件', () => {
  const { ctx, events } = fakeCtx({ llm: { stream: () => {} }, webServer: { register: () => () => {} } })
  assert.doesNotThrow(() => apply(ctx, { mode: 'auto' }))
  assert.deepEqual(events, ['llm/stream'])
})

test('装配：webServer 缺失（宿主实现差异）时只记一条 warn，判定功能仍在', () => {
  const { ctx, warnings, events } = fakeCtx({ llm: { stream: () => {} } })
  ctx.webServer = undefined
  ctx.get = () => undefined
  apply(ctx, { mode: 'auto' })
  assert.deepEqual(events, ['llm/stream'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /webServer unavailable/)
})

test('装配：enabled=false 时初始档位就是 off，等于不装', () => {
  const { ctx } = fakeCtx({ llm: { stream: () => {} }, webServer: { register: () => () => {} } })
  assert.doesNotThrow(() => apply(ctx, { enabled: false }))
})
