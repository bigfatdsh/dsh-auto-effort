/**
 * 虚拟档位的 id。
 *
 * 它是插件内部的哨兵值：请求头上带着 `auto` 时，判定接管这一次调用；出站前会把它
 * 换成模型真正支持的档位。模型目录**不**再暴露它——模型切换列表只显示模型自己的
 * 等级，开关在插件自己的"优化"面板里。
 *
 * @module dsh-auto-effort/efforts
 */

/** 虚拟档位的 id。 */
export const AUTO_EFFORT_ID = 'auto'
