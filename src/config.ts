import { Schema } from 'koishi'

/**
 * 插件配置项。
 * 所有字段均通过 Koishi Schema 声明，可在控制台可视化配置。
 */
export interface Config {
  // ===== P0 基础指令 =====
  /** 指令白名单：仅这些 userId 可使用 qzone.* 指令；留空时仅超级管理员(authority>=3)可用 */
  allowUserIds: string[]
  /** qzone.feeds 未指定条数时的默认值（1~10） */
  defaultFeedsCount: number
  /** 好友动态列表内存缓存时长（毫秒），默认 30 秒 */
  feedsCacheMs: number

  // ===== 登录态（Cookie）管理 =====
  /** 通过 get_cookies 获取 Cookie 的域名，按顺序依次回退 */
  cookieDomains: string[]
  /** 期望提供 get_cookies 的机器人平台；留空表示任意平台 */
  cookieBotPlatforms: string[]
  /** Cookie 单域内存缓存时长（毫秒） */
  cookieCacheMs: number
  /** 续绑失败指数退避基础延迟（毫秒），默认 60 秒 */
  renewBaseDelayMs: number
  /** 退避延迟封顶（毫秒），默认 300 秒 */
  renewMaxDelayMs: number
  /** 连续失败达到该次数后停止自动续绑 */
  renewMaxFailures: number
  /** 单次 HTTP 请求超时（毫秒），透传给 qzone-sdk */
  sdkRequestTimeoutMs: number

  // ===== 模型配置（由 YesImBot ModelService 调度） =====
  /** 日记生成的模型组（YesImBot 任务键，如 chat / summarize / memory） */
  mainModel: string
  /** 自动互动的模型组（一般选择更轻量的模型） */
  subModel: string

  // ===== P2 每日记忆动态 =====
  /** 是否启用每日记忆动态 */
  diaryEnabled: boolean
  /** 每日触发时刻 HH:mm，默认 23:00 */
  diaryTime: string
  /** 记忆采集的频道 cid 列表（格式 platform:channelId）；留空则按最近活跃自动发现 */
  diaryChannels: string[]
  /** 自动发现时的最多频道数，避免大批量扫描 */
  diaryMaxChannels: number
  /** 单频道当天最多取回的消息条数 */
  diaryMaxMessagesPerChannel: number
  /** 人格预设 ID：data/yesimbot/memory/core/ 下核心记忆块的文件名(label)或标题 */
  personaPresetId: string
  /** 日记生成失败最大重试次数（默认 7） */
  diaryGenerateRetries: number
  /** 生成重试间隔（毫秒），默认 5 秒 */
  diaryGenerateRetryDelayMs: number

  // ===== P3 QQ 空间自动互动 =====
  /** 是否启用自动互动 */
  interactionEnabled: boolean
  /** 轮询间隔（分钟），默认 60 */
  interactionIntervalMin: number
  /** 单轮写操作（评论/回复）上限，默认 5 */
  interactionMaxWritesPerRound: number
  /** 单轮读取的动态条数上限 */
  interactionPostsPerRound: number
  /** 互动白名单：仅与这些作者/评论者互动；留空表示不限制 */
  interactionAllowUserIds: string[]
  /** 内存中水位、已见评论等状态的保留时长（毫秒），超过后清理 */
  interactionStateRetentionMs: number

  // ===== 发布 =====
  /** 图片下载并发数上限，默认 3 */
  publishImageConcurrency: number
  /** 单张图片大小上限（字节），默认 32MB */
  publishMaxImageBytes: number

  // ===== 其他 =====
  /** 需要人工核对时的通知目标 userId 列表；留空仅输出日志 */
  alertTargets: string[]
  /** 开启后输出完整提示词与响应等调试日志；关闭时仅输出 warn/error */
  debug: boolean
}

/** Koishi Schema 定义 */
export const Config = Schema.object({
  // ===== P0 基础指令 =====
  allowUserIds: Schema.array(Schema.string().required())
    .default([])
    .description('指令白名单：仅这些 userId 可使用 qzone.* 指令；留空时仅超级管理员可用')
  defaultFeedsCount: Schema.number()
    .min(1)
    .max(10)
    .default(5)
    .description('qzone.feeds 未指定条数时的默认值 (1~10)')
  feedsCacheMs: Schema.number()
    .default(30_000)
    .description('好友动态列表内存缓存时长（毫秒），默认 30000')

  // ===== 登录态（Cookie）管理 =====
  cookieDomains: Schema.array(Schema.string().required())
    .default(['qzone.qq.com', 'user.qzone.qq.com', 'h5.qzone.qq.com', 'qun.qq.com', 'ti.qq.com'])
    .description('通过 get_cookies 获取 Cookie 的域名，按顺序依次回退')
  cookieBotPlatforms: Schema.array(Schema.string().required())
    .default(['onebot'])
    .description('期望提供 get_cookies 的机器人平台（如 onebot）；留空表示任意平台')
  cookieCacheMs: Schema.number()
    .default(300_000)
    .description('Cookie 单域内存缓存时长（毫秒），默认 300000')
  renewBaseDelayMs: Schema.number()
    .default(60_000)
    .description('续绑失败指数退避基础延迟（毫秒），默认 60000')
  renewMaxDelayMs: Schema.number()
    .default(300_000)
    .description('退避延迟封顶（毫秒），默认 300000')
  renewMaxFailures: Schema.number()
    .default(3)
    .description('连续失败达到该次数后停止自动续绑')
  sdkRequestTimeoutMs: Schema.number()
    .default(15_000)
    .description('单次 HTTP 请求超时（毫秒），透传给 qzone-sdk')

  // ===== 模型配置 =====
  mainModel: Schema.string()
    .default('chat')
    .description('日记生成的模型组（YesImBot 任务键，如 chat / summarize / memory）')
  subModel: Schema.string()
    .default('chat')
    .description('自动互动的模型组（建议配置更轻量的模型）')

  // ===== P2 每日记忆动态 =====
  diaryEnabled: Schema.boolean().default(true).description('是否启用每日记忆动态')
  diaryTime: Schema.string()
    .pattern(/^\d{1,2}:\d{2}$/)
    .default('23:00')
    .description('每日触发时刻 HH:mm，默认 23:00')
  diaryChannels: Schema.array(Schema.string())
    .default([])
    .description('记忆采集的频道 cid 列表（格式 platform:channelId）；留空则按最近活跃自动发现')
  diaryMaxChannels: Schema.number()
    .default(10)
    .description('自动发现时的最多频道数，避免大批量扫描')
  diaryMaxMessagesPerChannel: Schema.number()
    .default(300)
    .description('单频道当天最多取回的消息条数')
  personaPresetId: Schema.string()
    .default('')
    .description('人格预设 ID：data/yesimbot/memory/core/ 下核心记忆块的文件名(label)或标题')
  diaryGenerateRetries: Schema.number()
    .default(7)
    .description('日记生成失败最大重试次数（默认 7）')
  diaryGenerateRetryDelayMs: Schema.number()
    .default(5_000)
    .description('生成重试间隔（毫秒），默认 5000')

  // ===== P3 自动互动 =====
  interactionEnabled: Schema.boolean().default(true).description('是否启用自动互动')
  interactionIntervalMin: Schema.number()
    .default(60)
    .description('轮询间隔（分钟），默认 60')
  interactionMaxWritesPerRound: Schema.number()
    .default(5)
    .description('单轮写操作（评论/回复）上限，默认 5')
  interactionPostsPerRound: Schema.number()
    .max(20)
    .default(10)
    .description('单轮读取的动态条数上限（SDK 上限 20）')
  interactionAllowUserIds: Schema.array(Schema.string())
    .default([])
    .description('互动白名单：仅与这些作者/评论者互动；留空表示不限制')
  interactionStateRetentionMs: Schema.number()
    .default(7 * 24 * 3600 * 1000)
    .description('内存中水位、已见评论等状态的保留时长（毫秒），超过后清理')

  // ===== 发布 =====
  publishImageConcurrency: Schema.number()
    .default(3)
    .description('图片下载并发数上限，默认 3')
  publishMaxImageBytes: Schema.number()
    .default(32 * 1024 * 1024)
    .description('单张图片大小上限（字节），默认 32MB')

  // ===== 其他 =====
  alertTargets: Schema.array(Schema.string())
    .default([])
    .description('需要人工核对时的通知目标 userId 列表；留空仅输出日志')
  debug: Schema.boolean().default(false).description('开启后输出完整提示词与响应等调试日志；关闭时仅输出 warn/error')
})
