import { Context, Logger } from 'koishi'
import {
  Services,
  TaskType,
  type ChatModelSwitcher,
  type ModelService,
} from 'koishi-plugin-yesimbot'
import { Config } from '../config'
import type { NotifyFn } from '../types'
import { sleep } from '../utils'
import { MemoryCollector, type MemoryCollection } from './memory-collector'
import { QzoneClientManager, describeOutcome } from './qzone-manager'

/**
 * DiaryScheduler —— P2 每日记忆动态
 *
 * 设计要点：
 * 1. 使用 setTimeout 递归调度（而非 setInterval），避免任务堆积；
 * 2. 每天配置时刻（默认 23:00）从 WorldStateService 采集当天记忆，
 *    结合 personaPresetId 指定的人格，用 mainModel 生成第一人称日记体动态并发布；
 * 3. 生成失败最多重试 7 次、间隔 5 秒；
 * 4. 发布遵循确定性结果语义：结果不确定时绝不自动重发，只提示人工核对；
 * 5. 当日无记忆则跳过；停机或重载错过触发时刻不补发。
 */
export class DiaryScheduler {
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly qzone: QzoneClientManager,
    private readonly collector: MemoryCollector,
    private readonly logger: Logger,
    private readonly notify: NotifyFn,
  ) {}

  start(): void {
    if (!this.config.diaryEnabled) return
    this.schedule()
  }

  /** 计算下一个触发时刻并递归调度；若已过触发时刻则顺延到次日（错过不补发） */
  private schedule(): void {
    const [hour, minute] = this.config.diaryTime.split(':').map(Number)
    const now = new Date()
    let next = new Date()
    next.setHours(hour, minute, 0, 0)
    if (now >= next) {
      next.setDate(next.getDate() + 1)
    }
    const delay = next.getTime() - now.getTime()
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, delay)
    this.debug(`下一次日记生成任务：${next.toLocaleString()}`)
  }

  private async run(): Promise<void> {
    try {
      await this.executeDaily()
    } catch (error) {
      this.logger.error(`每日日记执行异常：${(error as Error).message}`)
    } finally {
      // 无论成功失败都在下一日相应时刻继续（不补发当日）
      if (!this.disposed) this.schedule()
    }
  }

  /**
   * 手动触发一次日记流程（关键词触发使用）。
   * 与定时任务执行同一逻辑，不受 diaryTime 时间限制。
   */
  async runNow(): Promise<string> {
    this.debug('手动触发日记流程')
    return this.executeDaily()
  }

  private async executeDaily(): Promise<string> {
    const date = new Date()
    const collection = await this.collector.collect(date)
    if (!collection) {
      this.debug('当日无记忆，跳过日记发布')
      return '当天还没有可用的记忆素材，已跳过日记生成'
    }

    const persona = this.resolvePersona()
    const diaryText = await this.generate(collection, persona)
    if (!diaryText) {
      this.logger.error('日记生成失败且重试已耗尽，放弃本次发布')
      return '日记生成失败（已按配置重试多次），本次放弃发布'
    }

    const result = await this.qzone.publish(diaryText)
    const message = describeOutcome('日记发布', result.outcome)
    if (result.outcome === 'unknown') {
      // 确定性语义：结果不确定绝不自动重发
      this.notify(`${message}
时间：${date.toLocaleString()}`)
      return '日记已发出但结果无法确认，请到 QQ 空间人工核对（已通过安全渠道提醒）'
    }
    if (result.outcome === 'verified' || result.outcome === 'accepted') {
      this.notify(`[日记] ${message}`)
      return `日记发布成功：${message}`
    }
    return `日记流程完成：${message}`
  }

  /** 调用 mainModel 生成日记正文；失败按配置重试（默认最多 7 次，间隔 5 秒） */
  private async generate(collection: MemoryCollection, persona: string): Promise<string | null> {
    const model = this.resolveModel(this.config.mainModel)
    if (!model) {
      this.logger.error('主模型不可用，无法生成日记（请检查 mainModel 配置）')
      return null
    }

    const prompt = this.buildDiaryPrompt(collection, persona)
    // 完整提示词仅在开启 debug 时输出
    this.debug(`[日记生成提示词]
${prompt}`)

    for (let attempt = 1; attempt <= this.config.diaryGenerateRetries; attempt++) {
      try {
        const res = await model.chat({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
        })
        const text = (res.text ?? '').trim()
        if (!text) throw new Error('模型输出为空')
        this.debug(`[日记生成响应]
${text}`)
        return text
      } catch (error) {
        this.logger.warn(`日记生成第 ${attempt}/${this.config.diaryGenerateRetries} 次失败：${(error as Error).message}`)
        if (attempt < this.config.diaryGenerateRetries) {
          await sleep(this.config.diaryGenerateRetryDelayMs)
        }
      }
    }
    return null
  }

  /** 解析人格：personaPresetId 指向 data/yesimbot/memory/core/ 下的核心记忆块 */
  private resolvePersona(): string {
    const id = this.config.personaPresetId?.trim()
    if (!id) return ''
    const memoryService = this.ctx[Services.Memory] as any
    if (!memoryService) return ''
    try {
      const block = memoryService.getMemoryBlocksForRendering().find(
        (b: { label: string; title: string }) => b.label === id || b.title === id,
      )
      if (block?.content) return block.content.trim()
      this.logger.warn(`人格预设 ${id} 未在核心记忆目录中找到，将按默认人格生成`)
    } catch {
      this.logger.warn('读取核心记忆块失败，将按默认人格生成')
    }
    return ''
  }

  /** 通过 YesImBot ModelService 解析模型组（支持任务键，如 chat / summarize / memory） */
  private resolveModel(group: string): ChatModelSwitcher | null {
    try {
      const service: ModelService | undefined = this.ctx[Services.Model]
      if (!service?.useChatGroup) return null
      return service.useChatGroup(group) ?? service.useChatGroup(TaskType.Chat) ?? null
    } catch {
      return null
    }
  }

  private buildDiaryPrompt(collection: MemoryCollection, persona: string): string {
    const materials = this.collector.formatForPrompt(collection)
    return [
      '你是长期写“生活日记”的人。请把下面的“当天记忆素材”改写成一篇第一人称日记动态，准备发布到 QQ 空间。',
      '要求：',
      '1. 全程使用“我”的第一人称；',
      '2. 内容严格基于素材，不得无中生有；素材中的对话可转述为你的所见所闻；',
      '3. 语气自然、真诚，带一点生活感，像真人随手写下的心情记录；',
      '4. 篇幅控制在 100~200 字；',
      '5. 只输出日记正文本身，不要任何解释、标题或 markdown 标记。',
      '',
      '【人格设定】',
      persona || '（无额外设定，自然即可）',
      '',
      '【当天记忆素材】',
      materials,
      '',
      '日记正文：',
    ].join('\n')
  }

  private debug(...args: any[]): void {
    if (this.config.debug) (this.logger.debug as any).apply(this.logger, args)
  }

  /** 插件卸载时清理定时器 */
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
