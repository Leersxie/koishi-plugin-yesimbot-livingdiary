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
      if (!this.disposed) this.schedule()
    }
  }

  private async executeDaily(): Promise<void> {
    const date = new Date()
    const collection = await this.collector.collect(date)
    if (!collection) return
    const persona = this.resolvePersona()
    const diaryText = await this.generate(collection, persona)
    if (!diaryText) return
    const result = await this.qzone.publish(diaryText)
    const message = describeOutcome('日记发布', result.outcome)
    if (result.outcome === 'unknown') {
      this.notify(`需人工核对：
${message}
时间：${date.toLocaleString()}`)
    } else if (result.outcome === 'verified' || result.outcome === 'accepted') {
      this.notify(`[日记] ${message}`)
    } else {
      this.logger.warn(message)
    }
  }

  /** 调用 mainModel 生成日记正文；失败按配置重试（默认最多 7 次，间隔 5 秒） */
  private async generate(collection: MemoryCollection, persona: string): Promise<string | null> {
    const model = this.resolveModel(this.config.mainModel)
    if (!model) {
      this.logger.error('主模型不可用，无法生成日记（请检查 mainModel 配置）')
      return null
    }
    const prompt = this.buildDiaryPrompt(collection, persona)
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
      this.logger.warn(`人格预设 ${id} 未找到，将按默认人格生成`)
    } catch {
      this.logger.warn('读取核心记忆块失败，将按默认人格生成')
    }
    return ''
  }

  /** 通过 YesImBot ModelService 解析模型组 */
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
      '2. 内容严格基于素材，不得无中生有；',
      '3. 语气自然、真诚，带一点生活感；',
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

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
