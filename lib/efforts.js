/**
 * 档位常量：宿主与浏览器半边共用一份，避免两边对"哪个文字代表哪个档位"各写一套。
 *
 * @module dsh-auto-effort/efforts
 */

/** 虚拟档位（"自动"）的 id：出现在模型选择器的推理等级列表里。 */
export const AUTO_EFFORT_ID = 'auto'

/** 虚拟档位的显示名。 */
export const AUTO_EFFORT_NAME = 'Auto'

/**
 * 模型自带的等级显示名（宿主适配器里的 `name`）。
 *
 * 只用来判断"这次点击是不是用户手动选了真实等级"；未列出的名字按"不是等级"处理，
 * 不会误清标记。
 */
export const REAL_EFFORT_NAMES = Object.freeze(['Off', 'Low', 'Medium', 'High', 'Max'])
