/** 通知函数：用于「结果不确定，需人工核对」时的告警（发送私聊或仅日志） */
export type NotifyFn = (text: string) => void
