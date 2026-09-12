import { Context, Logger, Schema, Session } from 'koishi'
import { Extension, Tool, Services, Success, Failed, withInnerThoughts, type Infer, type ToolCallResult } from 'koishi-plugin-yesimbot'
import type { QzoneError } from 'qzone-sdk'
import { Config } from './config'
import { CookieManager } from './services/cookie-manager'
import { DiaryScheduler } from './services/diary-scheduler'
import { downloadImage } from './services/images'
import { InteractionService } from './services/interaction-service'
import { MemoryCollector } from './services/memory-collector'
import { QzoneClientManager, describeOutcome } from './services/qzone-manager'
import type { NotifyFn } from './types'
import { mapLimit, formatTime, truncate } from './utils'

/**
 * YesImBot 扩展：QQ 空间生活日记
 *
 * 通过 @Extension 注册为 YesImBot 的扩展，提供：
 * - P0：qzone.feeds / qzone.publish / qzone.status 三条指令；
 * - P1：qzone_publish 模型工具（白名单外会话不可见）；
 * - P2：每日记忆动态（DiaryScheduler）；
 * - P3：空间自动互动（InteractionService）。
 *
 * 登录态只存内存（CookieManager），不写磁盘。
 */

/**
 * 模块级实例引用。
 * 说明：@Tool 装饰器只把 execute 方法 bind 到实例，isSupported 由框架直接以
 * `tool.isSupported(session)` 调用而不会绑定 this，因此权限判定通过该引用完成。
 */
let activeInstance: YesImBotLivingDiary | null = null

@Extension({
  name: 'yesimbot-livingdiary',
  display: '生活日记',
  description: '为 YesImBot 提供 QQ 空间生活日记能力：自动记录并发布日记、读写动态、自动互动。',
  version: '1.0.0',
  author: 'LivingDiary',
})
export default class YesImBotLivingDiary {
  static readonly Config = Config
  static readonly inject = [Services.Model, Services.WorldState, Services.Memory, 'database']

  /** 工具参数的最大图片数（对齐 QQ 空间动态上限） */
  private static readonly MAX_IMAGES = 9

  private readonly logger: Logger
  private readonly cookieMgr: CookieManager
  private readonly qzone: QzoneClientManager
  private readonly collector: MemoryCollector
  private readonly diary: DiaryScheduler
  private readonly interaction: InteractionService

  constructor(public readonly ctx: Context, public readonly config: Config) {
    // 实例构造完成即登记，供 isSupported 白名单判定使用（不使用 this，见上方注释）
    activeInstance = this
    this.logger = ctx.logger('yesimbot-livingdiary')
    this.cookieMgr = new CookieManager(ctx, config, this.logger)
    this.qzone = new QzoneClientManager(ctx, config, this.cookieMgr, this.logger)
    this.collector = new MemoryCollector(ctx, config, this.logger)
    this.diary = new DiaryScheduler(ctx, config, this.qzone, this.collector, this.logger, this.notify.bind(this))
    this.interaction = new InteractionService(ctx, config, this.qzone, this.logger, this.notify.bind(this))

    // 就绪后启动定时任务；卸载时统一清理定时器与客户端
    ctx.on('ready', () => {
      this.diary.start()
      this.interaction.start()
    })
    ctx.on('dispose', () => {
      this.diary.dispose()
      this.interaction.dispose()
      this.cookieMgr.dispose()
      void this.qzone.close()
    })

    this.registerCommands()
  }

  // ==================== P1 模型工具 ====================

  /**
   * qzone_publish：把文字（可附图）发布到机器人自己的 QQ 空间。
   * 工具描述写清楚“把这张图发到空间，配文 xxx”这类意图。
   * 白名单外会话通过 isSupported 隐藏该工具。
   */
  @Tool<{ content: string; images?: string[] }>({
    name: 'qzone_publish',
    description:
      '发布动态到机器人自己的 QQ 空间。适合以下意图：把图片发到空间并配文（“把这张图发到空间，配文XXX”、“发条空间说说：XXX”、“发个带图的空间动态”）。文字最长建议 1000 字；图片最多 9 张，单张不超过 32MB，支持 http(s) 图片链接或本地文件路径。',
    parameters: withInnerThoughts({
      content: Schema.string().required().description('要发布到 QQ 空间的正文内容（配文）'),
      images: Schema.array(Schema.string())
        .max(YesImBotLivingDiary.MAX_IMAGES)
        .description('要附带的图片地址列表，最多 9 张，支持 http(s) 链接、data: 或本地文件路径'),
    }),
    isSupported: (session?: Session) => {
      // 白名单外会话工具不可见；session 未附加或实例未就绪时同样隐藏
      if (!session) return false
      return activeInstance?.isAllowed(session) ?? false
    },
  })
  async qzonePublish(args: Infer<{ content: string; images?: string[] }>): Promise<ToolCallResult> {
    const content = (args.content ?? '').trim()
    const images = (args.images ?? []).slice(0, YesImBotLivingDiary.MAX_IMAGES)
    if (!content && !images.length) {
      return Failed({ name: 'ValidationError', message: '发布内容与图片不能同时为空', retryable: false })
    }
    try {
      // 有限并发下载图片（默认最多 3 张同时），避免打满带宽
      const inputs = await mapLimit(images, this.config.publishImageConcurrency, (url) =>
        downloadImage(url, this.config.publishMaxImageBytes),
      )
      const result = await this.qzone.publish(content, inputs)
      const message = describeOutcome('发布', result.outcome)
      if (result.outcome === 'unknown') {
        // 确定性语义：结果不确定绝不自动重发
        return Failed({ name: 'QzoneUncertainResult', message, retryable: false })
      }
      return Success({ outcome: result.outcome, postId: result.post?.id ?? result.reference?.id ?? null, message })
    } catch (error) {
      return Failed({
        name: 'QzoneRequestError',
        message: (error as Error).message,
        // 写操作走确定性语义：是否已发出无法判断，一律标记为不可重试
        retryable: false,
      })
    }
  }

  // ==================== P0 指令 ====================

  private registerCommands(): void {
    this.ctx.command('qzone', 'QQ 空间生活日记（feeds / publish / status）')

    this.ctx
      .command('qzone.feeds [count:number]', '读取 QQ 空间动态列表')
      .option('target', '-t <qq> 指定要读取的 QQ 号；省略则读取机器人自己的动态')
      .action(async ({ session, options }, count) => {
        return this.authorize(session, async () => {
          const limit = Math.max(1, Math.min(count ?? this.config.defaultFeedsCount, 10))
          try {
            const ownId = this.qzone.sessionAccountId()
            const target = options?.target
            // 目标与自己的账号不一致时读取对方公开动态，否则读自己的动态
            const page =
              target && target !== ownId
                ? await this.qzone.listFeeds({ scope: 'profile', userId: target, limit })
                : await this.qzone.listFeeds({ scope: 'self', limit })
            const items = page.items ?? []
            if (!items.length) return 'QQ 空间暂时没有动态'
            const lines = items.map((post, index) => {
              const summary = truncate(post.content || '（无正文，有图片/其他内容）', 60)
              return `${index + 1}. ${formatTime(post.createdAt)} · ${post.author.nickname} [赞 ${post.likeCount} | 评 ${post.commentCount}]\n   ${summary}`
            })
            return lines.join('\n')
          } catch (error) {
            return `读取动态失败：${this.friendlyError(error)}`
          }
        })
      })

    this.ctx
      .command('qzone.publish <content:text>', '发布文字动态到自己的 QQ 空间')
      .action(async ({ session }, content) => {
        return this.authorize(session, async () => {
          const text = (content ?? '').trim()
          if (!text) return '内容不能为空'
          try {
            const result = await this.qzone.publish(text)
            const message = describeOutcome('发布', result.outcome)
            if (result.outcome === 'unknown') {
              return `⚠️ ${message}（已通过安全渠道记录，请勿重复操作）`
            }
            this.notify(`[日记] ${message}`)
            return message
          } catch (error) {
            return `发布失败：${this.friendlyError(error)}`
          }
        })
      })

    this.ctx.command('qzone.status', '查看 QQ 空间登录态状态').action(async ({ session }) => {
      return this.authorize(session, async () => {
        return this.buildStatusText()
      })
    })
  }

  /** 白名单校验：白名单外用户不可使用任何 qzone 指令 */
  private authorize(session: Session | undefined, action: () => Promise<string>): Promise<string> {
    if (!this.isAllowed(session)) {
      return Promise.resolve('你没有权限使用 qzone 指令')
    }
    return action()
  }

  /** 白名单判定；留空名单时仅超级管理员（authority>=3）可用 */
  private isAllowed(session?: Session | null): boolean {
    if (!session?.userId) return false
    if (this.config.allowUserIds.includes(session.userId)) return true
    // user 可能未附加（Observed 类型），取 authority 失败时按 0 处理
    if (!this.config.allowUserIds.length) return ((session.user as { authority?: number } | undefined)?.authority ?? 0) >= 3
    return false
  }

  /** 将 qzone-sdk 的 QzoneError 转成用户可读信息 */
  private friendlyError(error: unknown): string {
    const text = (error as Error).message
    const e = error as QzoneError
    switch (e?.code) {
      case 'QZONE_AUTH':
        return `登录态失效，续绑已在后台进行，请稍后重试（${text}）`
      case 'QZONE_RATE_LIMIT':
        return `触发频率限制，请稍后再试`
      case 'QZONE_NOT_FOUND':
        return `目标不存在或不可访问`
      case 'QZONE_PERMISSION':
        return `当前账号无权访问该目标`
      default:
        return text
    }
  }

  /** qzone.status 文本：协议、账号、在线状态、Cookie 有效性、自动续绑健康 */
  private async buildStatusText(): Promise<string> {
    const source = this.cookieMgr.sourceInfo()
    const info = this.qzone.sessionInfo()
    const health = this.cookieMgr.healthInfo()
    const lines: string[] = ['【QQ 空间登录态】']
    if (source) {
      lines.push(`来源机器人：${source.platform} #${source.selfId}（${source.online ? '在线' : '离线'}）`)
    } else {
      lines.push('来源机器人：未获取（尚未触发登录态获取）')
    }
    lines.push('协议：QQ 空间 Web（qzone-sdk）')
    lines.push(`账号：${info?.accountId ?? '未知'}`)
    lines.push(`登录态：${info ? (info.authenticated ? '有效' : '异常（需续绑）') : '未获取'}`)

    const cookies = this.cookieMgr.snapshot()
    const hasKey = Boolean(cookies.p_skey || cookies.skey)
    lines.push(
      `Cookie 有效性：${Object.keys(cookies).length ? (hasKey ? '有效（已取得会话密钥）' : '部分（缺少 p_skey/skey）') : '无缓存'}`,
    )

    const fmt = (ts: number) => (ts ? new Date(ts).toLocaleString() : '—')
    lines.push('【自动续绑健康】')
    lines.push(`最后成功：${fmt(health.lastSuccessAt)}`)
    lines.push(`最后失败：${fmt(health.lastFailureAt)} · 连续失败 ${health.failureStreak} 次`)
    lines.push(
      health.stopped
        ? '状态：已停止自动续绑（连续失败过多，需人工处理）'
        : `状态：${health.nextRetryAt ? `退避中，下次重试 ${fmt(health.nextRetryAt)}` : '正常'}`,
    )
    return lines.join('\n')
  }

  // ==================== 人工核对通知 ====================

  /** 结果不确定 / 重要事件时告警：私聊通知配置的 alertTargets；否则仅输出 warn 日志 */
  private notify(text: string): void {
    const targets = this.config.alertTargets
    if (!targets.length) {
      this.logger.warn(`[需人工核对] ${text}`)
      return
    }
    const bot = this.ctx.bots.find((b) => b.online)
    if (!bot) {
      this.logger.warn(`[需人工核对] ${text}（无在线机器人可推送）`)
      return
    }
    for (const uid of targets) {
      void bot.sendPrivateMessage(uid, text).catch(() => {})
    }
  }
}
