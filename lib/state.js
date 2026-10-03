/**
 * 运行档的唯一持有者（Host 半边）。
 *
 * ## 为什么状态在 Host
 *
 * 它决定的是**模型拿到什么推理强度**，那是 Host 的事实。放在 localStorage 会出现
 * "界面显示自动、模型其实没收到"的窗口（新标签页、刷新、第二条会话），而这种不一致
 * 用户永远查不出来。浏览器只做两件事：开局读一次、点击写一次。
 *
 * ## 为什么落盘在 <DSH_HOME>
 *
 * 这是单值偏好，一个 JSON 文件就够；走设置层要重写补丁，代价大、失败面宽。
 * 写盘全部 best-effort：盘只读、目录不存在、内容坏掉，都回落到内存值。
 *
 * ## 为什么写入是原子的
 *
 * 直接写目标文件时崩溃会留下半个 JSON，下次启动读到坏值。先写同目录临时文件再
 * rename：同一文件系统内 rename 是原子的，读到的要么是旧完整值、要么是新完整值。
 *
 * @module dsh-auto-effort/state
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 状态文件名（位于 `<DSH_HOME>`）。 */
export const STORE_FILENAME = 'auto-effort.json'

/** 运行档取值；顺序即界面上的循环顺序。 */
export const RUN_MODES = ['auto', 'pin', 'off']

/**
 * 解析 DSH 主目录。
 *
 * 与宿主一致：`DSH_HOME` 优先，否则 `~/.dsh`。
 *
 * @returns {string} 绝对路径。
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * 运行档容器。
 */
export class ToggleState {
  /** @type {'auto'|'pin'|'off'} */
  #mode
  /** @type {string|undefined} */
  #file
  /** @type {(error: unknown) => void} */
  #onError

  /**
   * @param {object} options - `{ initial, file, onError }`。
   *   `initial` 必须是 RUN_MODES 之一，否则回落 `auto`；`file` 为绝对路径，给不出就纯内存。
   */
  constructor(options = {}) {
    this.#mode = RUN_MODES.includes(options.initial) ? options.initial : 'auto'
    this.#file = typeof options.file === 'string' && options.file !== '' ? options.file : undefined
    this.#onError = typeof options.onError === 'function' ? options.onError : () => {}
  }

  /** @returns {'auto'|'pin'|'off'} 当前运行档。 */
  get() {
    return this.#mode
  }

  /**
   * 写入一个运行档。
   *
   * @param {unknown} next - 目标值；非法值不改变现状。
   * @returns {'auto'|'pin'|'off'} 写入后的运行档。
   */
  set(next) {
    if (!RUN_MODES.includes(next)) return this.#mode
    this.#mode = next
    this.#write()
    return this.#mode
  }

  /**
   * 从磁盘读回上次的选择。读不到、读坏、字段不认识都保持当前值。
   *
   * @returns {Promise<boolean>} 是否真的读到了一个有效值。
   */
  async load() {
    if (this.#file === undefined) return false
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
      const mode = parsed !== null && typeof parsed === 'object' ? parsed.mode : undefined
      if (!RUN_MODES.includes(mode)) return false
      this.#mode = mode
      return true
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') this.#onError(error)
      return false
    }
  }

  /** 写盘；任何失败只上报，不影响内存值。 */
  #write() {
    if (this.#file === undefined) return
    const file = this.#file
    const temp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify({ mode: this.#mode }, null, 2)}\n`, 'utf8')
      renameSync(temp, file)
    } catch (error) {
      this.#onError(error)
      try {
        rmSync(temp, { force: true })
      } catch {
        // 清理失败无所谓：临时文件带 pid，不会污染下次读取。
      }
    }
  }
}

/**
 * 状态文件路径。
 *
 * @param {string} [home] - 覆盖 DSH 主目录（测试用）。
 * @returns {string} 绝对路径。
 */
export function statePath(home) {
  const base = typeof home === 'string' && home !== '' ? home : resolveDshHome()
  return join(base, STORE_FILENAME)
}
