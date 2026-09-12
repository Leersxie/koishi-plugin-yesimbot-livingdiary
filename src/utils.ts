/**
 * 共享工具函数。
 * 全部为纯异步/同步小函数，无任何副作用。
 */

/** 等待指定毫秒数（异步非阻塞） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 并发受限的 map：图片下载、写请求等需要限制并发数的场景使用。
 * 任一任务失败即抛出首个错误（其余任务仍会完成）。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const errors: unknown[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i], i)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  if (errors.length) throw errors[0]
  return results
}

/** 去除可能包裹的 ```json ``` 代码围栏后再解析 JSON */
export function parseJsonLoose(text: string): any {
  let t = text.trim()
  t = t.replace(/^```(?:json)?s*/i, '').replace(/```s*$/, '')
  try {
    return JSON.parse(t)
  } catch {
    // 若解析失败，尝试截取首尾的大括号片段
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(t.slice(start, end + 1))
    }
    throw new Error(`无法解析模型输出为 JSON: ${t.slice(0, 100)}`)
  }
}

/** 截断文本，保留指定长度 */
export function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 将 ISO 时间字符串格式化为本地 MM-DD HH:mm；无效时返回 '未知' */
export function formatTime(iso: string | null): string {
  if (!iso) return '未知'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '未知'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 当天日期键（UTC，与 YesImBot L3 日记表的 date 字段保持一致） */
export function utcDateKey(date: Date): string {
  return date.toISOString().split('T')[0]
}

/** 解析 "a=1; b=2" 形式的 Cookie Header 为名值对象 */
export function parseCookieHeader(raw: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) map[key] = value
  }
  return map
}

/** 根据文件扩展名推断 MIME 类型（用于图片上传） */
export function mimeFromName(name: string): string | undefined {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  const table: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  }
  return table[ext]
}

/** 从 URL 中提取文件名（用于图片上传的 name 字段） */
export function basenameFromUrl(url: string): string {
  try {
    const path = url.split(/[?#]/)[0]
    const name = path.slice(path.lastIndexOf('/') + 1)
    return name || 'image'
  } catch {
    return 'image'
  }
}
