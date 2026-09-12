import { Context, Logger } from 'koishi'
import { TableName } from 'koishi-plugin-yesimbot'
import { Config } from '../config'
import { utcDateKey } from '../utils'

/** 单个频道采集到的“当天记忆” */
export interface ChannelMemory {
  platform: string
  channelId: string
  /** 记忆来源：L3 日记优先，无日记时退回 L1 当天消息 */
  source: 'diary' | 'messages'
  /** 组装好的记忆文本（供 LLM 生成日记使用） */
  text: string
  /** 素材条数 */
  count: number
}

export interface MemoryCollection {
  dateKey: string
  channels: ChannelMemory[]
  totalCount: number
}

interface ChannelRef {
  platform: string
  channelId: string
}

const MIN_MESSAGES = 1

/**
 * MemoryCollector
 *
 * 从 YesImBot 的 WorldStateService 数据中采集“当天记忆”，不自行维护任何记忆存储：
 * - L3 日记（worldstate.l3_diaries）：当天已有归档日记 → 直接使用其正文；
 * - L1 工作记忆（worldstate.messages）：当天消息，按时间升序取回带发送者名称；
 * - L2 语义记忆不参与（日记生成只需当天事实素材，不做全量扫描）。
 *
 * 查询全部带时间范围（startOfDay ≤ t < endOfDay），接口支持分页/字段裁剪时均已使用，
 * 避免全表扫描。
 */
export class MemoryCollector {
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /** 采集指定日期的记忆；当日无任何素材时返回 null（调用方跳过发布） */
  async collect(date: Date): Promise<MemoryCollection | null> {
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)
    const dateKey = utcDateKey(date)

    const channels = await this.resolveChannels(date, startOfDay, endOfDay)
    if (!channels.length) {
      this.logger.warn('[记忆采集] 未发现任何活跃频道，当日跳过')
      return null
    }

    const list: ChannelMemory[] = []
    for (const channel of channels) {
      const memory = await this.collectChannel(channel, startOfDay, endOfDay, dateKey)
      if (memory) list.push(memory)
    }

    if (!list.length) {
      this.logger.warn('[记忆采集] 无可用记忆，跳过')
      return null
    }

    return {
      dateKey,
      channels: list,
      totalCount: list.reduce((sum, c) => sum + c.count, 0),
    }
  }

  /** 解析需要采集的频道列表：配置优先，否则按最近活跃自动发现（带限流） */
  private async resolveChannels(date: Date, startOfDay: Date, endOfDay: Date): Promise<ChannelRef[]> {
    const configured = this.parseConfiguredChannels()
    if (configured.length) return configured

    // 自动发现：只取最近活跃的一批消息对应的频道，避免全表扫描
    // minato 的 database.get 直接返回 Promise（结果已在内存），在此做排序去重
    const rows = await this.ctx.database.get(
      TableName.Messages,
      { timestamp: { $gte: startOfDay, $lt: endOfDay } },
      ['platform', 'channelId', 'timestamp'],
    )
    rows.sort((a, b) => +b.timestamp - +a.timestamp)
    const seen = new Set<string>()
    const channels: ChannelRef[] = []
    for (const row of rows) {
      const key = row.platform + ':' + row.channelId
      if (seen.has(key)) continue
      seen.add(key)
      channels.push({ platform: row.platform, channelId: row.channelId })
      if (channels.length >= this.config.diaryMaxChannels) break
    }
    return channels
  }

  /** 解析配置的 "platform:channelId" 条目 */
  private parseConfiguredChannels(): ChannelRef[] {
    const list: ChannelRef[] = []
    for (const entry of this.config.diaryChannels) {
      const idx = entry.indexOf(':')
      if (idx <= 0) {
        this.logger.warn('[记忆采集] 忽略非法频道配置：' + entry + '（应为 platform:channelId）')
        continue
      }
      list.push({ platform: entry.slice(0, idx), channelId: entry.slice(idx + 1) })
    }
    return list
  }

  /** 采集单个频道当天的记忆：L3 日记优先，其次 L1 当天消息 */
  private async collectChannel(
    channel: ChannelRef,
    startOfDay: Date,
    endOfDay: Date,
    dateKey: string,
  ): Promise<ChannelMemory | null> {
    const [diaries, messages] = await Promise.all([
      this.ctx.database.get(TableName.L3Diaries, { platform: channel.platform, channelId: channel.channelId, date: dateKey }, ['content']),
      this.ctx.database.get(
        TableName.Messages,
        {
          platform: channel.platform,
          channelId: channel.channelId,
          timestamp: { $gte: startOfDay, $lt: endOfDay },
        },
        ['sender', 'content', 'timestamp'],
      ),
    ])

    if (diaries[0]?.content?.trim()) {
      return {
        platform: channel.platform,
        channelId: channel.channelId,
        source: 'diary',
        text: diaries[0].content.trim(),
        count: 1,
      }
    }

    // 内存升序排序后截取最新的一批
    const ordered = [...messages].sort((a, b) => +a.timestamp - +b.timestamp)
    const msgs = ordered.slice(0, this.config.diaryMaxMessagesPerChannel).filter((m) => Boolean(m.content && m.sender))
    if (msgs.length < MIN_MESSAGES) return null

    const text = msgs
      .map((m) => {
        const name = m.sender?.name || m.sender?.id || '未知'
        return '[' + name + ']: ' + m.content
      })
      .join('
')

    return {
      platform: channel.platform,
      channelId: channel.channelId,
      source: 'messages',
      text,
      count: msgs.length,
    }
  }

  /** 将采集结果格式化为对模型可见的素材文本 */
  formatForPrompt(collection: MemoryCollection): string {
    return collection.channels
      .map((c) => '【频道 ' + c.channelId + '（' + c.platform + '）' + (c.source === 'diary' ? '· 已有日记' : '') + '】
' + c.text)
      .join('

')
  }
}
