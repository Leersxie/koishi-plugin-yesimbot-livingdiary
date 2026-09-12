import { Bot, Context, Logger } from 'koishi'
import { Config } from '../config'
import { parseCookieHeader } from '../utils'

/**
 * 登录态（Cookie）管理器的健康状态。
 * 全部仅存内存，不落盘。
 */
export interface CookieHealth {
  /** 最近一次成功获取时间戳 */
  lastSuccessAt: number
  /** 最近一次失败时间戳 */
  lastFailureAt: number
  /** 当前连续失败次数 */
  failureStreak: number
  /** 退避后的下一次自动重试时间戳；null 表示无计划 */
  nextRetryAt: number | null
  /** 连续失败达到上限，停止自动续绑（需手动触发恢复） */
  stopped: boolean
}

/** 最近一次成功获取时使用的机器人信息（用于 qzone.status 展示） */
export interface CookieSourceBot {
  platform: string
  selfId: string
  online: boolean
}

interface DomainCache {
  cookies: Record<string, string>
  fetchedAt: number
}

type GetCookiesFn = (domain: string) => Promise<Record<string, string>>

interface CookieBotCandidate {
  bot: Bot
  preferred: boolean
  getCookies: GetCookiesFn
}

const MIN_FAILURES = 1

/**
 * CookieManager
 *
 * 设计要点：
 * 1. 通过同实例已登录机器人（OneBot / Milky）的 get_cookies 接口实时获取登录态；
 * 2. 按域名依次回退（get_cookies 需要指定域名的 p_skey / skey）；
 * 3. Cookie 在内存中按域名缓存，避免每次请求都调用 get_cookies；
 * 4. 续绑失败使用指数退避（基数 60s，封顶 300s），连续失败 3 次停止自动续绑；
 * 5. 登录态仅存内存，绝不写磁盘、绝不进入日志。
 */
export class CookieManager {
  private readonly domainCache = new Map<string, DomainCache>()
  /** 当前合并后的内存 Cookie（最新成功获取结果 + SDK 运行期回写） */
  private cookies: Record<string, string> = {}
  private fetchAt = 0
  private dirty = false
  private inFlight: Promise<Record<string, string>> | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private disposed = false
  private sourceBot: CookieSourceBot | null = null
  /** 健康状态（仅存内存） */
  private readonly healthState: CookieHealth = {
    lastSuccessAt: 0,
    lastFailureAt: 0,
    failureStreak: 0,
    nextRetryAt: null,
    stopped: false,
  }

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /** 当前内存 Cookie 的只读快照（防外部篡改） */
  snapshot(): Record<string, string> {
    return { ...this.cookies }
  }

  /** 是否被标记为失效（收到 QzoneAuthError 后） */
  isDirty(): boolean {
    return this.dirty
  }

  /** 标记登录态失效：下一次 acquire 将强制重新获取 */
  markDirty(): void {
    this.dirty = true
  }

  /** 合并 SDK 运行期回写的 Cookie/Token（仍只存内存） */
  merge(cookies: Record<string, string>): void {
    Object.assign(this.cookies, cookies)
  }

  /** 健康状态只读快照（方法名 healthInfo 用于避开 Bot.health 类成员） */
  healthInfo(): CookieHealth {
    return { ...this.healthState }
  }

  sourceInfo(): CookieSourceBot | null {
    return this.sourceBot
  }

  /**
   * 获取可用会话 Cookie。
   * @param force 为 true 时无视缓存与 dirty 标记，强制向机器人重新获取
   */
  async acquire(force = false): Promise<Record<string, string>> {
    // 单飞：并发调用共享同一次获取，避免 get_cookies 风暴
    if (this.inFlight) return this.inFlight
    this.inFlight = this._acquire(force)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async _acquire(force: boolean): Promise<Record<string, string>> {
    // 缓存有效且未被标记失效时直接返回（高频指令 <500ms 的关键路径）
    if (!force && !this.dirty && this.isFreshEnough()) {
      return this.snapshot()
    }

    const candidates = this.findBots()
    if (!candidates.length) {
      throw new Error('未找到支持 get_cookies 的机器人（OneBot/Milky），无法获取 QQ 空间登录态')
    }

    const merged: Record<string, string> = {}
    let lastError: Error | null = null
    let anySucceeded = false

    // 按域名依次回退：单域名失败不影响其他域名
    for (const domain of this.config.cookieDomains) {
      const cached = this.domainCache.get(domain)
      if (!force && !this.dirty && cached && Date.now() - cached.fetchedAt < this.config.cookieCacheMs) {
        Object.assign(merged, cached.cookies)
        if (this.hasAuthKey(merged)) break
        continue
      }
      try {
        const got = await this.getViaCandidates(candidates, domain)
        if (Object.keys(got).length) {
          anySucceeded = true
          this.domainCache.set(domain, { cookies: got, fetchedAt: Date.now() })
          Object.assign(merged, got)
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.logger.warn(`获取 Cookie 失败，尝试下一个域名（${domain}）：${lastError.message}`)
      }
      // 已识别账号且有会话密钥 → 提前结束，不再请求剩余域名
      if (this.hasAuthKey(merged)) break
    }

    if (!anySucceeded || !Object.keys(merged).length) {
      this.onFailure(lastError ?? new Error('所有域名均未获取到 Cookie'))
      throw lastError ?? new Error('所有域名均未获取到 Cookie')
    }

    if (!this.hasAuthKey(merged)) {
      // 拿到了 Cookie 但没有账号/会话密钥，仍视为不完整
      this.onFailure(new Error('获取到的 Cookie 缺少账号字段或会话密钥'))
      throw new Error('获取到的 Cookie 缺少账号字段（uin）或会话密钥（p_skey/skey）')
    }

    this.onSuccess(merged)
    return this.snapshot()
  }

  /** 缓存是否仍然“新鲜够用” */
  private isFreshEnough(): boolean {
    if (!this.fetchAt || !Object.keys(this.cookies).length) return false
    if (!this.hasAuthKey(this.cookies)) return false
    return Date.now() - this.fetchAt < this.config.cookieCacheMs
  }

  /** 识别到账号且有会话密钥即认为登录态可用 */
  private hasAuthKey(cookies: Record<string, string>): boolean {
    const hasAccount = Boolean(cookies.uin || cookies.p_uin)
    const hasKey = Boolean(cookies.p_skey || cookies.skey)
    return hasAccount && hasKey
  }

  /** 找出支持 get_cookies 的机器人，优先筛选配置的平台 */
  private findBots(): CookieBotCandidate[] {
    const list: CookieBotCandidate[] = []
    for (const bot of this.ctx.bots) {
      const internal = (bot as any).internal as any
      if (!internal) continue
      const fn = internal.getCookies ?? internal.get_cookies
      if (typeof fn !== 'function') continue
      const preferred =
        !this.config.cookieBotPlatforms.length ||
        (bot.platform != null && this.config.cookieBotPlatforms.includes(bot.platform))
      list.push({
        bot,
        preferred,
        getCookies: async (domain: string) => {
          const res = await fn.call(internal, domain)
          const raw =
            res?.cookies ??
            res?.data?.cookies ??
            (typeof res === 'string' ? res : '') ??
            ''
          return parseCookieHeader(raw)
        },
      })
    }
    list.sort((a, b) => Number(b.preferred) - Number(a.preferred))
    return list
  }

  /** 依次尝试候选机器人，第一个成功返回即止 */
  private async getViaCandidates(candidates: CookieBotCandidate[], domain: string): Promise<Record<string, string>> {
    let lastError: unknown = null
    for (const candidate of candidates) {
      try {
        const got = await candidate.getCookies(domain)
        if (Object.keys(got).length) return got
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('所有候选机器人都调用失败')
  }

  private onSuccess(cookies: Record<string, string>): void {
    this.cookies = { ...cookies }
    this.fetchAt = Date.now()
    this.dirty = false
    // satorijs Bot.online 是方法不是属性，用 isActive / status 判断在线状态
    const bot = this.ctx.bots.find((b) => b.isActive)
    this.sourceBot =
      this.sourceBot ??
      (bot ? { platform: bot.platform ?? bot.adapterName, selfId: bot.selfId, online: Boolean(bot.isActive) } : null)
    this.healthState.lastSuccessAt = Date.now()
    this.healthState.lastFailureAt = 0
    this.healthState.failureStreak = 0
    this.healthState.nextRetryAt = null
    this.healthState.stopped = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private onFailure(error: Error): void {
    this.dirty = true
    this.healthState.lastFailureAt = Date.now()
    this.healthState.failureStreak++
    if (this.healthState.failureStreak >= this.config.renewMaxFailures) {
      this.healthState.stopped = true
      this.healthState.nextRetryAt = null
      this.logger.error(
        `Cookie 自动续绑已连续失败 ${this.config.renewMaxFailures} 次，停止自动续绑；请检查机器人登录态后手动执行 qzone.status 或重载插件恢复`,
      )
      return
    }
    // 指数退避：base * 2^(streak-1)，封顶 max
    const delay = Math.min(
      this.config.renewBaseDelayMs * 2 ** Math.max(this.healthState.failureStreak - MIN_FAILURES, 0),
      this.config.renewMaxDelayMs,
    )
    this.healthState.nextRetryAt = Date.now() + delay
    this.scheduleRetry(delay)
  }

  /** 后台指数退避重试（不阻塞任何调用方） */
  private scheduleRetry(delay: number): void {
    if (this.disposed || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disposed || this.healthState.stopped) return
      this.logger.warn('正在按照退避计划尝试自动续绑 Cookie…')
      void this.acquire(true).catch(() => {
        // 失败由 onFailure 处理并调度下一轮
      })
    }, delay)
  }

  /** 插件卸载时清理定时器与缓存 */
  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.domainCache.clear()
    this.cookies = {}
    this.inFlight = null
  }
}
