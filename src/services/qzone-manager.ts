import { Context, Logger } from 'koishi'
import {
  QzoneAuthError,
  QzoneClient,
  type CommentMutationResult,
  type FeedPage,
  type ListFeedsOptions,
  type MutationOutcome,
  type PostMutationResult,
  type PublishImageInput,
  type QzoneComment,
  type QzoneLogEvent,
  type QzonePost,
  type QzoneSessionInput,
} from 'qzone-sdk'
import { Config } from '../config'
import { CookieManager } from './cookie-manager'

/**
 * 写操作结果的可读描述（确定性结果语义）。
 * 关键约定：发送后结果不确定（unknown）时绝不自动重发，只提示人工核对。
 */
export function describeOutcome(kind: string, outcome: MutationOutcome): string {
  switch (outcome) {
    case 'verified':
      return kind + '成功（已确认生效）'
    case 'accepted':
      return kind + '请求已被服务器接受，暂未读回最终状态，请稍后查看'
    case 'already-applied':
      return '目标已处于目标状态，无需重复' + kind
    case 'unknown':
      return kind + '请求已发出但结果无法确认，请人工到 QQ 空间核对，切勿重复操作'
  }
}

/**
 * QzoneClientManager
 *
 * 职责：
 * 1. 负责 QzoneClient 的懒创建 / 续绑更新 / 释放，实例绑定一个账号；
 * 2. 好友动态列表内存缓存（默认 30 秒）；
 * 3. 统一封装“只读操作（续绑后重试一次）”与“写操作（绝不自动重发）”的差异；
 * 4. SDK 运行期回写的 Cookie 通过 onSessionChange 仅回存内存。
 */
export class QzoneClientManager {
  private client: QzoneClient | null = null
  private friendsCache: { at: number; page: FeedPage } | null = null
  /** 防止并发的 close/重建 */
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly cookieMgr: CookieManager,
    private readonly logger: Logger,
  ) {}

  /** 当前账号 id（未获取登录态时为 null） */
  sessionAccountId(): string | null {
    return this.client?.getSessionInfo().accountId ?? null
  }

  /** 当前客户端登录态信息（用于 qzone.status） */
  sessionInfo() {
    return this.client?.getSessionInfo() ?? null
  }

  /** 获取已就绪的客户端（命令入口使用）；获取失败时抛出可读错误 */
  async getReady(): Promise<QzoneClient> {
    return this.requireClient(false)
  }

  /**
   * 内部：确保 client 就绪。
   * @param forceRefresh 为 true 时强制重新获取 Cookie 并更新客户端 Session
   */
  private async requireClient(forceRefresh: boolean): Promise<QzoneClient> {
    if (this.client && !forceRefresh) return this.client
    if (this.closing) throw new Error('客户端正在关闭中')
    const cookies = await this.cookieMgr.acquire(forceRefresh)
    if (this.client) {
      // 优先原地更新 Session；账号不一致等校验失败时降级为重建
      const input: QzoneSessionInput = { cookies }
      try {
        await this.client.updateSession(input)
        return this.client
      } catch {
        this.logger.warn('Cookie 更新失败（可能账号变更），重建 QzoneClient')
      }
    }
    await this.client?.close().catch(() => {})
    this.client = this.buildClient(cookies)
    return this.client
  }

  private buildClient(cookies: Record<string, string>): QzoneClient {
    return new QzoneClient({
      session: { cookies },
      requestTimeoutMs: this.config.sdkRequestTimeoutMs,
      // SDK 日志只含白名单字段（阶段/端点/耗时/状态码），可安全转发
      logger: (event: QzoneLogEvent) => this.forwardSdkLog(event),
      // 运行期回写 Cookie/Token：仅回存内存，绝不写磁盘
      onSessionChange: (session) => {
        this.cookieMgr.merge({ ...session.cookies })
      },
    })
  }

  /** SDK 日志分级转发：默认只有 warn/error 上浮，debug 全量输出 */
  private forwardSdkLog(event: QzoneLogEvent): void {
    const lines = ['[qzone-sdk] ' + event.phase + (event.endpoint ? ' ' + event.endpoint : '') + (event.durationMs != null ? ' ' + event.durationMs + 'ms' : '')]
    if (event.level === 'warn' || event.level === 'error') {
      this.logger.warn(lines.join(''))
    } else if (this.config.debug) {
      this.logger.debug(lines.join(''))
    }
  }

  /**
   * 只读操作统一入口：遇到 QzoneAuthError 时先续绑，再重试一次。
   * 读操作重复执行是安全的。
   */
  async read<T>(op: (client: QzoneClient) => Promise<T>): Promise<T> {
    try {
      return await op(await this.requireClient(false))
    } catch (error) {
      if (error instanceof QzoneAuthError) {
        this.cookieMgr.markDirty()
        // 后台立即触发续绑
        void this.cookieMgr.acquire(true).catch(() => {})
        this.logger.warn('登录态失效，已触发自动续绑，正在重试本次只读操作…')
        return op(await this.requireClient(true))
      }
      throw error
    }
  }

  /**
   * 写操作统一入口：遇到 QzoneAuthError 时只标记失效并后台续绑，
   * 绝不自动重发写请求（遵循确定性结果语义）。
   */
  async write<T>(op: (client: QzoneClient) => Promise<T>): Promise<T> {
    try {
      return await op(await this.requireClient(false))
    } catch (error) {
      if (error instanceof QzoneAuthError) {
        this.cookieMgr.markDirty()
        void this.cookieMgr.acquire(true).catch(() => {})
        throw new Error('登录态失效，续绑已在后台进行；本次写操作未重发，请人工核对')
      }
      throw error
    }
  }

  /**
   * 读取动态列表。
   * 好友动态（friends，无光标时）命中 30 秒内存缓存，其余实时读取。
   */
  async listFeeds(options: ListFeedsOptions): Promise<FeedPage> {
    const { scope } = options
    if (scope === 'friends' && !options.cursor) {
      if (this.friendsCache && Date.now() - this.friendsCache.at < this.config.feedsCacheMs) {
        return this.friendsCache.page
      }
      const page = await this.read((c) => c.listFeeds(options))
      this.friendsCache = { at: Date.now(), page }
      return page
    }
    return this.read((c) => c.listFeeds(options))
  }

  /** 读取动态详情（含评论） */
  async getPost(post: QzonePost): Promise<QzonePost> {
    return this.read((c) => c.getPost({ post }))
  }

  /** 发布动态（纯文字/带图）。 */
  async publish(content: string, images: PublishImageInput[] = []): Promise<PostMutationResult> {
    if (!content.trim() && !images.length) {
      throw new Error('发布内容与图片不能同时为空')
    }
    return this.write((c) =>
      c.publishPost({
        ...(content.trim() ? { content: content.trim() } : {}),
        ...(images.length ? { images } : {}),
      }),
    )
  }

  /** 发表评论 */
  async comment(post: QzonePost, content: string): Promise<CommentMutationResult> {
    return this.write((c) => c.comment({ post, content }))
  }

  /** 回复评论 */
  async reply(post: QzonePost, comment: QzoneComment, content: string): Promise<CommentMutationResult> {
    return this.write((c) => c.reply({ post, comment, content }))
  }

  /** 插件卸载时释放客户端 */
  async close(): Promise<void> {
    this.closing = true
    const client = this.client
    this.client = null
    this.friendsCache = null
    if (client) {
      await client.close().catch(() => {})
    }
  }
}
