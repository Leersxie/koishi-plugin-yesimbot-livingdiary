import { Context, Logger } from 'koishi'
import {
  Services,
  TaskType,
  type ChatModelSwitcher,
  type ModelService,
} from 'koishi-plugin-yesimbot'
import type { MutationOutcome, QzoneComment, QzonePost } from 'qzone-sdk'
import { Config } from '../config'
import type { NotifyFn } from '../types'
import { parseJsonLoose, truncate } from '../utils'
import { QzoneClientManager, describeOutcome } from './qzone-manager'

/** 单条动态的决策结果 */
interface Decision {
  action: 'comment' | 'reply' | 'skip'
  content?: string
}

/**
 * InteractionService —— P3 QQ 空间自动互动
 *
 * 设计要点：
 * 1. 使用 setTimeout 递归轮询（而非 setInterval），轮询间隔可配置（默认 60 分钟）；
 * 2. 监控好友新动态与 Bot 自己动态下的新评论，将正文/评论送入 subModel 决策；
 * 3. 单轮写操作有上限（interactionMaxWritesPerRound，默认 5）且串行执行；
 * 4. 支持互动白名单 interactionAllowUserIds（留空表示不限制）；
 * 5. 水位、已见评论、决策结果全部只存内存（Map/Set 带时间戳），定期清理；重启后清空且不补扫；
 * 6. 每条动态只做一次 publish/skip 决策，跳过不反复询问；
 * 7. 所有写操作通过 QzoneClientManager.write 走确定性结果语义。
 */
export class InteractionService {
  /** 已见过的好友动态 id -> 时间戳 */
  private readonly seenPosts = new Map<string, number>()
  /** 已决策的动态 id -> 决策 */
  private readonly decided = new Map<string, { action: string; at: number }>()
  /** 自己动态下已见过的评论 id -> 时间戳 */
  private readonly seenComments = new Map<string, number>()
  /** 最近自己发布的动态 id -> 时间戳 */
  private readonly ownPosts = new Map<string, number>()

  private timer: NodeJS.Timeout | null = null
  private running = false
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly qzone: QzoneClientManager,
    private readonly logger: Logger,
    private readonly notify: NotifyFn,
  ) {}

  start(): void {
    if (!this.config.interactionEnabled) return
    this.schedule()
  }

  /** 递归调度下一轮轮询 */
  private schedule(): void {
    if (this.disposed) return
    const delay = this.config.interactionIntervalMin * 60_000
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }

  /** 单轮轮询：防重入（上一轮未结束时不会开启新一轮），结束后再调度下一轮 */
  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.round()
    } catch (error) {
      this.logger.warn(`自动互动轮询异常：${(error as Error).message}`)
    } finally {
      this.running = false
      if (!this.disposed) this.schedule()
    }
  }

  private async round(): Promise<void> {
    this.pruneState()
    let writes = 0
    const ownId = this.qzone.sessionAccountId()
    const allowed = this.config.interactionAllowUserIds

    // 1) 好友新动态 → 决策是否评论
    try {
      const page = await this.qzone.listFeeds({ scope: 'friends', limit: this.config.interactionPostsPerRound })
      for (const post of page.items ?? []) {
        if (writes >= this.config.interactionMaxWritesPerRound) break
        if (post.author.id === ownId) continue
        // 白名单外：直接记录为跳过，跳过不反复询问
        if (allowed.length && !allowed.includes(post.author.id)) {
          this.recordSeen(post.id)
          this.recordDecision(post.id, 'skip')
          continue
        }
        this.recordSeen(post.id)
        const decision = await this.decide(post, 'comment')
        this.recordDecision(post.id, decision.action)
        if (decision.action === 'comment' && decision.content) {
          try {
            const result = await this.qzone.comment(post, decision.content)
            this.handleWriteResult('评论', result.outcome)
          } catch (error) {
            this.logger.warn(`评论失败：${(error as Error).message}`)
          }
          writes++
        }
      }
    } catch (error) {
      this.logger.warn(`好友动态轮询失败：${(error as Error).message}`)
    }

    // 2) 自己动态下的新评论 → 决策是否回复
    try {
      const selfPage = await this.qzone.listFeeds({ scope: 'self', limit: Math.min(5, this.config.interactionPostsPerRound) })
      for (const post of selfPage.items ?? []) {
        if (writes >= this.config.interactionMaxWritesPerRound) break
        this.ownPosts.set(post.id, Date.now())
        let detail: QzonePost
        try {
          detail = await this.qzone.getPost(post)
        } catch {
          continue // 详情读取失败（含动态已删除）→ 跳过该动态
        }
        for (const comment of detail.comments ?? []) {
          if (writes >= this.config.interactionMaxWritesPerRound) break
          if (this.seenComments.has(comment.id)) continue
          this.seenComments.set(comment.id, Date.now())
          if (comment.author.id === ownId) continue
          if (allowed.length && !allowed.includes(comment.author.id)) continue
          const decision = await this.decideReply(detail, comment)
          if (decision.action === 'reply' && decision.content) {
            try {
              const result = await this.qzone.reply(detail, comment, decision.content)
              this.handleWriteResult('回复', result.outcome)
            } catch (error) {
              this.logger.warn(`回复失败：${(error as Error).message}`)
            }
            writes++
          }
        }
      }
    } catch (error) {
      this.logger.warn(`自己动态评论监控失败：${(error as Error).message}`)
    }

    this.debug(`自动互动轮询完成，本轮写操作 ${writes} 次`)
  }

  /** 好友动态决策：subModel 判断是否评论 */
  private async decide(post: QzonePost, kind: 'comment'): Promise<Decision> {
    const prompt = [
      '你在 QQ 空间浏览好友动态，请判断要不要评论这条动态。',
      '【好友动态】',
      truncate(post.content || '（无正文，仅有图片）', 800),
      '【互动策略】',
      '- 内容有趣、有共鸣、与自己相关 → 评论（自然真实，10~30 字）',
      '- 内容无感、与自己无关 → 跳过',
      '只输出 JSON：{"action":"comment|skip","content":"评论内容（action 为 comment 时必填）"}',
      '',
    ].join('
')
    return this.askModel(prompt, kind)
  }

  /** 自己动态下的评论决策：subModel 判断是否回复 */
  private async decideReply(post: QzonePost, comment: QzoneComment): Promise<Decision> {
    const prompt = [
      '你在 QQ 空间发了一条动态，收到一条新评论。请判断要不要回复这条评论。',
      '【我的动态】',
      truncate(post.content || '（无正文）', 400),
      '【他人的评论】',
      `${comment.author.nickname}：${truncate(comment.content, 400)}`,
      '【互动策略】',
      '- 值得互动 → 回复（自然真实，10~30 字）',
      '- 无需理会 → 跳过',
      '只输出 JSON：{"action":"reply|skip","content":"回复内容（action 为 reply 时必填）"}',
      '',
    ].join('
')
    return this.askModel(prompt, 'reply')
  }

  /** 调用 subModel 并解析结构化决策；任何异常一律降级为 skip（绝不写） */
  private async askModel(prompt: string, kind: 'comment' | 'reply'): Promise<Decision> {
    const model = this.resolveModel(this.config.subModel)
    if (!model) return { action: 'skip' }
    this.debug(`[互动决策提示词]
${prompt}`)
    try {
      const res = await model.chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6,
        validation: { format: 'json' },
      })
      this.debug(`[互动决策响应]
${res.text}`)
      const parsed = parseJsonLoose(res.text ?? '{}')
      const action = parsed?.action === kind ? kind : 'skip'
      const content = typeof parsed?.content === 'string' ? parsed.content.trim().slice(0, 300) : ''
      if (action !== 'skip' && !content) return { action: 'skip' }
      return { action, content }
    } catch (error) {
      this.logger.warn(`互动决策解析失败，跳过：${(error as Error).message}`)
      return { action: 'skip' }
    }
  }

  /** 通过 YesImBot ModelService 解析 subModel 模型组 */
  private resolveModel(group: string): ChatModelSwitcher | null {
    try {
      const service: ModelService | undefined = this.ctx[Services.Model]
      if (!service?.useChatGroup) return null
      return service.useChatGroup(group) ?? service.useChatGroup(TaskType.Chat) ?? null
    } catch {
      return null
    }
  }

  /** 写操作结果按确定性语义处置 */
  private handleWriteResult(kind: string, outcome: MutationOutcome): void {
    const message = describeOutcome(kind, outcome)
    if (outcome === 'unknown') {
      this.notify(message)
    } else if (outcome === 'accepted') {
      this.logger.warn(message)
    } else {
      this.debug(message)
    }
  }

  private recordSeen(postId: string): void {
    this.seenPosts.set(postId, Date.now())
  }

  private recordDecision(postId: string, action: string): void {
    // 已决策则保留首次决策，跳过不反复询问
    if (!this.decided.has(postId)) {
      this.decided.set(postId, { action, at: Date.now() })
    }
  }

  /** 定期清理过期内存状态，避免无限增长 */
  private pruneState(): void {
    const cutoff = Date.now() - this.config.interactionStateRetentionMs
    const prune = (map: Map<string, number>) => {
      for (const [key, at] of map) {
        if (at < cutoff) map.delete(key)
      }
      if (map.size > 5000) {
        // 兜底：容量超限时清空最旧的一半
        const entries = [...map.entries()]
        for (const [key, at] of entries.slice(0, Math.floor(entries.length / 2))) {
          map.delete(key)
        }
      }
    }
    prune(this.seenPosts)
    prune(this.seenComments)
    prune(this.ownPosts)
    for (const [key, value] of this.decided) {
      if (value.at < cutoff) this.decided.delete(key)
    }
  }

  private debug(...args: any[]): void {
    if (this.config.debug) (this.logger.debug as any).apply(this.logger, args)
  }

  /** 插件卸载时清理定时器与内存状态 */
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.seenPosts.clear()
    this.decided.clear()
    this.seenComments.clear()
    this.ownPosts.clear()
  }
}
