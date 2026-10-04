/**
 * 配置契约：Standard Schema v1（`~standard`）。
 *
 * ## 为什么手写
 *
 * profile 里的插件由 pnpm 装进 profile 目录，能确定解析到的只有 `node:*` 与本包
 * 文件；`@deepseek-ai/schemastery` 不在那里。手写换来两件事：装配失败时给出确切
 * 字段名，以及校验路径与单测完全一致。
 *
 * ## 行为
 *
 * 成功返回**补全默认值**的副本；未知键直接拒绝（拼错的配置项会在装配时就暴露，
 * 而不是静默用默认值）。失败返回 `issues`，由宿主带着原因拒绝装配。
 *
 * @module dsh-auto-effort/schema
 */

import { AUTO_EFFORT_ID, AUTO_EFFORT_NAME } from './efforts.js'

/** 一个字段的共同行为：解析、报错路径。 */
class Field {
  /**
   * @param {object} options - `{ default }`；给出 default 即视为可选。
   */
  constructor(options = {}) {
    this.hasDefault = Object.hasOwn(options, 'default')
    this.default = options.default
  }

  /** @returns {boolean} 是否允许 `undefined`。 */
  get optional() {
    return this.hasDefault
  }

  /**
   * 校验一个值。
   *
   * @param {unknown} value - 待校验值。
   * @param {string} path - 字段路径，用于报错。
   * @param {string[]} issues - 收集问题的数组。
   * @returns {unknown} 校验后的值。
   */
  validate(value, path, issues) {
    if (value === undefined) {
      if (this.optional) return this.default
      issues.push(`${path}: required`)
      return undefined
    }
    return this.check(value, path, issues)
  }

  /**
   * 子类实现的具体检查。
   *
   * @param {unknown} value - 非 undefined 的值。
   * @param {string} path - 字段路径。
   * @param {string[]} issues - 问题收集器。
   * @returns {unknown} 校验后的值。
   */
  check(value, path, issues) {
    return value
  }
}

/** 布尔字段。 */
class BooleanField extends Field {
  check(value, path, issues) {
    if (typeof value !== 'boolean') {
      issues.push(`${path}: expected boolean, got ${describe(value)}`)
      return this.optional ? this.default : undefined
    }
    return value
  }
}

/** 非负整数字段。 */
class NumberField extends Field {
  check(value, path, issues) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
    issues.push(`${path}: expected a non-negative integer, got ${typeof value === 'number' ? String(value) : describe(value)}`)
    return this.optional ? this.default : undefined
  }
}

/** 非空字符串字段。 */
class StringField extends Field {
  check(value, path, issues) {
    if (typeof value === 'string' && value !== '') return value
    issues.push(`${path}: expected a non-empty string, got ${describe(value)}`)
    return this.optional ? this.default : undefined
  }
}

/** 只接受枚举里某一个字符串的字段。 */
class EnumField extends Field {
  /**
   * @param {readonly string[]} values - 允许的取值。
   * @param {object} options - `{ default }`。
   */
  constructor(values, options = {}) {
    super(options)
    this.values = values
  }

  check(value, path, issues) {
    if (typeof value === 'string' && this.values.includes(value)) return value
    issues.push(`${path}: expected one of ${this.values.join(' | ')}, got ${describe(value)}`)
    return this.optional ? this.default : undefined
  }
}

/** 对象字段：逐个校验声明过的键，遇到没声明的键直接报错。 */
class ObjectField extends Field {
  /**
   * @param {Record<string, Field>} shape - 字段表。
   */
  constructor(shape) {
    super({})
    this.shape = shape
  }

  check(value, path, issues) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`${path === '' ? 'config' : path}: expected object, got ${describe(value)}`)
      return undefined
    }
    const source = /** @type {Record<string, unknown>} */ (value)
    const result = {}
    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(this.shape, key)) issues.push(`${path === '' ? '' : `${path}.`}${key}: unknown option`)
    }
    for (const [key, field] of Object.entries(this.shape)) {
      const next = field.validate(source[key], path === '' ? key : `${path}.${key}`, issues)
      if (next !== undefined || field.optional) result[key] = next
    }
    return result
  }
}

/**
 * @param {unknown} value - 任意值。
 * @returns {string} 用于报错的类型描述。
 */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 开关档位。 */
export const MODES = ['auto', 'pin', 'off']

/**
 * 上界配置。
 *
 * - `max`（默认）：不设人为上限，判定需要多少就是多少。
 * - `adapter-default`：不高于模型自己的默认档。
 * - 具体档位：固定上界。
 *
 * 默认不设上限是刻意的：上限存在的意义是"我不想为这次任务付更多思考 token"，
 * 那是用户偏好，不该由插件替他决定。
 */
export const CEILING_BOUNDS = ['max', 'adapter-default', 'off', 'low', 'high']

/** 上界的默认值：不设人为上限。判低了是省 token，判高了才是质量问题。 */
export const DEFAULT_CEILING = 'max'

/**
 * 下界配置。
 *
 * - `observed`（默认）：用户在模型选择器里选过的**真实档位**不再被降低。虚拟档位 `auto`
 *   不是真实档位，所以不受这条保护，判定照常接管。
 * - `adapter-default`：以模型自己的默认档为界（模型默认想多深就至少多深）。
 * - `off`：连手选值也可以被降——只有明确要求"自动判定全权接管"时才该用。
 * - 具体档位：固定下界。
 */
export const FLOOR_BOUNDS = ['observed', 'adapter-default', 'off', 'low', 'high', 'max']

/**
 * 下界的默认值：**保护手选的档位**。
 *
 * 手选 `high` 是明确指令，不该被一句"你好"降成 `off`——这是实测踩过的坑，所以默认守卫。
 */
export const DEFAULT_FLOOR = 'observed'

/** 虚拟档位的显示名与说明，进模型选择器的推理等级列表。 */
export const EFFORT_ID = AUTO_EFFORT_ID
export const EFFORT_NAME = AUTO_EFFORT_NAME

/** 插件配置 schema。 */
export const Config = new ObjectField({
  /** `auto` 自动判定；`pin` 只在用户没显式选强度时判定；`off` 完全不动请求。 */
  mode: new EnumField(MODES, { default: 'auto' }),
  /** 首次启动（还没有点过界面开关）时的默认值。 */
  enabled: new BooleanField({ default: true }),
  /** 把界面开关写到 `<DSH_HOME>/auto-effort.json`，重启后保持上次选择。 */
  persist: new BooleanField({ default: true }),
  /** 判定上限：超过它的档位一律压回来（`max` 表示不设上限）。 */
  maxTier: new EnumField(['off', 'low', 'high', 'max'], { default: 'max' }),
  /** 判定下限：低于它的档位一律抬上去。 */
  minTier: new EnumField(['off', 'low', 'high', 'max'], { default: 'off' }),
  /** 模型能力的下界：默认 `off` = 不设下界；`observed` 则保护选择器里已经选过的值。 */
  effortFloor: new EnumField(FLOOR_BOUNDS, { default: DEFAULT_FLOOR }),
  /** 模型能力的上界：默认 `max` = 不设人为上限（只有在需要多想时才用得上）。 */
  effortCeiling: new EnumField(CEILING_BOUNDS, { default: DEFAULT_CEILING }),
  /** 精简化输出在**首次**装配时的默认值（之后以状态文件里的值为准）。 */
  conciseDefault: new BooleanField({ default: false }),
  /** 进行中的任务最多跨多少条用户消息仍然有效（含糊短追问的继承窗口）。 */
  taskMaxAge: new NumberField({ default: 3 }),
  /** 每次判定打一行 info 日志（排查"到底改没改"时打开）。 */
  log: new BooleanField({ default: true }),
  /** 虚拟档位在模型目录里的 id（进选择器的推理等级列表）。 */
  effortId: new StringField({ default: EFFORT_ID }),
  /** 虚拟档位的显示名。 */
  effortName: new StringField({ default: EFFORT_NAME }),
  /** 虚拟档位的说明文字（选择器里 hover 会用到）。 */
  effortDescription: new StringField({
    default: 'Pick the reasoning effort from each request automatically.',
  }),
  /** 是否把虚拟档位当作模型默认档（新会话默认就是"自动"）。 */
  autoDefault: new BooleanField({ default: false }),
})

Object.defineProperty(Config, '~standard', {
  value: {
    version: 1,
    vendor: 'dsh-auto-effort',
    /**
     * @param {unknown} value - 待校验配置。
     * @returns {{ value: object } | { issues: { message: string }[] }} 校验结果。
     */
    validate: (value) => {
      const issues = []
      const parsed = Config.validate(value, '', issues)
      if (issues.length > 0) return { issues: issues.map((message) => ({ message })) }
      return { value: parsed }
    },
  },
  enumerable: false,
})

/**
 * 运行时兜底解析：校验保证"配置是对的"，这里保证"配置即使不对也不让插件静默失效"。
 *
 * @param {unknown} raw - bundle 补丁里的 config。
 * @returns {{ mode: string, enabled: boolean, persist: boolean, maxTier: string, minTier: string, effortFloor: string, effortCeiling: string, taskMaxAge: number, log: boolean, effortId: string, effortName: string, effortDescription: string, autoDefault: boolean }} 完整配置。
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const text = (key, fallback) => {
    const value = /** @type {Record<string, unknown>} */ (source)[key]
    return typeof value === 'string' && value !== '' ? value : fallback
  }
  const pick = (key, values, fallback) => {
    const value = /** @type {Record<string, unknown>} */ (source)[key]
    return typeof value === 'string' && values.includes(value) ? value : fallback
  }
  return {
    mode: pick('mode', MODES, 'auto'),
    enabled: source.enabled !== false,
    persist: source.persist !== false,
    maxTier: pick('maxTier', ['off', 'low', 'high', 'max'], 'max'),
    minTier: pick('minTier', ['off', 'low', 'high', 'max'], 'off'),
    effortFloor: pick('effortFloor', FLOOR_BOUNDS, DEFAULT_FLOOR),
    effortCeiling: pick('effortCeiling', CEILING_BOUNDS, DEFAULT_CEILING),
    conciseDefault: source.conciseDefault === true,
    taskMaxAge: Number.isSafeInteger(source.taskMaxAge) && source.taskMaxAge >= 0 ? source.taskMaxAge : 3,
    log: source.log !== false,
    effortId: text('effortId', EFFORT_ID),
    effortName: text('effortName', EFFORT_NAME),
    effortDescription: text('effortDescription', 'Pick the reasoning effort from each request automatically.'),
    autoDefault: source.autoDefault === true,
  }
}
