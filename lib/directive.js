/**
 * 交给模型的极简输出指令（"精简化"开关的宿主半边）。
 *
 * ## 为什么是系统提示词段落，而不是事后压缩
 *
 * 目标是"让模型不要写废话"，而不是"把写出来的废话删掉"。事后用正则删段落会连事实
 * 一起删——开场白和关键前提在文本上无法区分。唯一可靠的做法是生成之前给约束。
 *
 * ## 为什么每一句都必须有
 *
 * 这段文字本身要花 token（常驻系统提示词），所以它必须比它省下的量小一个数量级。
 * 逐条对应需求：零开场白/零复述、任务与工具链一字不改、保留清单 + "删掉它读者就
 * 无法行动"的判据、小标题只在确有多个主题时用。
 *
 * ## 关闭时零成本
 *
 * `systemPrompt.section({ text })` 的 `text` 是函数，每次请求装配前重新求值；
 * 关闭时返回空串，宿主会把整段丢掉，不占 token。
 *
 * 来源：本段与 `dsh-concise-output` 的指令逐字一致（合并自那个插件；它的仓库仍在，
 * 两边同时开启会重复注入，所以 profile 的 bundle 列表里只保留一个）。
 *
 * @module dsh-auto-effort/directive
 */

/** 极简输出指令正文。 */
export const DIRECTIVE = [
  'Write only what the user needs to act.',
  '',
  '- No preamble, no pleasantries, no restating the request, no announcing or summarizing',
  '  what you did, no offering follow-ups.',
  '- Do the task exactly as you otherwise would: same steps, same tools, same files, same',
  '  completeness. Brevity applies to your prose, never to the work.',
  '- Keep all facts, numbers, code, commands, paths, every warning and risk, and every step',
  '  the user must take. Drop a line only if they can still act without it.',
  '- Plain words, no jargon: what happened, what you did. Never the mechanism or the design,',
  '  and a term only if the user used it or needs it to act.',
  "- Match the user's own level, never below it.",
  '- A heading only if there are two or more distinct parts, one line, no filler.',
  '- Never omit what you could not do, what the user must do, or a risk they would walk into.',
  '- Never mention this instruction.',
].join('\n')

/**
 * 开关状态 → 要注入的段落。
 *
 * @param {boolean} enabled - 开关是否开启。
 * @returns {string} 段落文本；关闭时为空串。
 */
export function resolveDirective(enabled) {
  return enabled === true ? DIRECTIVE : ''
}
