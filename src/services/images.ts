import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { PublishImageInput } from 'qzone-sdk'
import { basenameFromUrl, mimeFromName } from '../utils'

/**
 * 图片下载模块。
 * - 支持 http(s) URL、data: URL、file:// URL 与本地绝对路径；
 * - 强制单张大小上限（默认 32MB）；
 * - 网络图片使用流式读取并在超限时立即中止，避免大文件占满内存。
 */

/** 网络下载最大重定向/读取超时 */
const HTTP_TIMEOUT_MS = 20_000

async function fetchWithLimit(
  url: string,
  maxBytes: number,
): Promise<{ data: Uint8Array; mime?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const mime = res.headers.get('content-type')?.split(';')[0].trim() || undefined
    // 若头部已声明大小，提前拦截
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > maxBytes) throw new Error(`图片超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)

    if (!res.body) {
      const buf = await res.arrayBuffer()
      if (buf.byteLength > maxBytes) throw new Error(`图片超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)
      return { data: new Uint8Array(buf), mime }
    }

    // 流式累计读取，超限立即中止
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`图片超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)
      }
      chunks.push(value)
    }
    const data = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { data, mime }
  } finally {
    clearTimeout(timer)
  }
}

function decodeDataUrl(source: string, maxBytes: number): { data: Uint8Array; mime?: string } {
  const match = /^data:([^;,]+)?(;base64)?,([sS]*)$/.exec(source)
  if (!match) throw new Error('无法解析 data: URL')
  const mime = match[1] || undefined
  const isBase64 = Boolean(match[2])
  const body = match[3]
  const buffer = isBase64
    ? Buffer.from(body, 'base64')
    : Buffer.from(decodeURIComponent(body), 'binary')
  if (buffer.byteLength > maxBytes) throw new Error(`图片超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)
  return { data: new Uint8Array(buffer), mime }
}

/**
 * 将单个图片来源下载/读取为 qzone-sdk 可接收的 PublishImageInput。
 * @param source http(s) URL / data: URL / file:// URL / 本地文件路径
 */
export async function downloadImage(source: string, maxBytes: number): Promise<PublishImageInput> {
  const trimmed = source.trim()
  if (!trimmed) throw new Error('图片地址为空')

  try {
    if (trimmed.startsWith('data:')) {
      const { data, mime } = decodeDataUrl(trimmed, maxBytes)
      return { data, name: 'image', mimeType: mime }
    }

    if (trimmed.startsWith('file://')) {
      const filePath = fileURLToPath(trimmed)
      const data = await readFile(filePath)
      if (data.byteLength > maxBytes) throw new Error(`图片超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)
      return { data, name: filePath.slice(filePath.lastIndexOf('/') + 1), mimeType: mimeFromName(filePath) }
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const { data, mime } = await fetchWithLimit(trimmed, maxBytes)
      const name = basenameFromUrl(trimmed)
      return { data, name, mimeType: mime ?? mimeFromName(name) }
    }

    // 本地绝对路径
    if (existsSync(trimmed)) {
      const data = await readFile(trimmed)
      if (data.byteLength > maxBytes) throw new Error(`图片超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)
      return { data, name: trimmed.slice(trimmed.lastIndexOf('\') + 1), mimeType: mimeFromName(trimmed) }
    }

    throw new Error('不支持的图片地址格式（仅支持 http(s)、data:、file: 或本地路径）')
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('图片下载超时')
    }
    throw error
  }
}
