# koishi-plugin-yesimbot-livingdiary

> YesImBot 扩展：QQ 空间生活日记 —— 自动记录并发布日记、读写空间动态、自动互动。

让配置了 YesImBot 的 Koishi 机器人拥有 QQ 空间“生活日记”能力：

- 定时从当天记忆生成第一人称日记并发布到 QQ 空间；
- 读取 QQ 空间动态（自己或指定账号的公开动态）；
- 发布文字/图文动态（支持模型直接调用）；
- 自动浏览好友动态、回应自己动态下的评论（可白名单控制）。

登录态通过同实例已登录的 OneBot / Milky 机器人 `get_cookies` 实时获取，**仅存内存、不落盘**；所有写操作遵循“结果不确定绝不自动重发”的确定性语义。

---

## 安装

在 Koishi 插件市场搜索 **`yesimbot-livingdiary`** 安装，或命令行安装：

```bash
npm install koishi-plugin-yesimbot-livingdiary
```

**依赖条件**

- Koishi v4.18+；
- 已启用 `koishi-plugin-yesimbot`；
- 同实例存在一个支持 `get_cookies` 接口的登录机器人（OneBot / Milky，通常为你的主 QQ 机器人）；
- 需要访问的数据库表由 YesImBot 提供（无需额外建表）。

---

## 配置详解

在 Koishi 控制台打开插件配置（当前截图对应字段见下），所有字段均可在界面上配置。

### P0 基础指令

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `allowUserIds` | string[] | `[]` | **指令白名单**：仅这些 userId 可使用 `qzone.*` 指令；留空时仅超级管理员(authority≥3)可用 |
| `defaultFeedsCount` | number | `5` | `qzone.feeds` 未指定条数时的默认值（1~10，硬上限 10） |
| `feedsCacheMs` | number | `30000` | 好友动态列表内存缓存时长（毫秒），高频查询提速 |

### 登录态（Cookie）管理

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `cookieDomains` | string[] | qzone 系列域名 | 通过 `get_cookies` 获取 Cookie 的域名，按顺序回退 |
| `cookieBotPlatforms` | string[] | `["onebot"]` | 期望提供 `get_cookies` 的机器人平台；留空 = 任意平台 |
| `cookieCacheMs` | number | `300000` | Cookie 单域名内存缓存时长（毫秒） |
| `renewBaseDelayMs` | number | `60000` | 续绑失败指数退避基础延迟（毫秒） |
| `renewMaxDelayMs` | number | `300000` | 退避延迟封顶（毫秒） |
| `renewMaxFailures` | number | `3` | 连续失败达到该次数后停止自动续绑 |
| `sdkRequestTimeoutMs` | number | `15000` | 单次 HTTP 请求超时（毫秒），透传给 qzone-sdk |

### 模型配置（由 YesImBot ModelService 调度）

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mainModel` | string | `chat` | 日记生成的模型组（YesImBot 任务键：`chat` / `summarize` / `memory`） |
| `subModel` | string | `chat` | 自动互动的模型组（建议独立配置一个更轻量的模型组） |

### P2 每日记忆动态

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `diaryEnabled` | boolean | `true` | 是否启用每日记忆动态 |
| `diaryTime` | string | `23:00` | 每日触发时刻（HH:mm） |
| `diaryChannels` | string[] | `[]` | 记忆采集的频道列表（格式 `platform:channelId`）；留空自动发现最近活跃频道 |
| `diaryMaxChannels` | number | `10` | 自动发现时最多频道数，避免全量扫描 |
| `diaryMaxMessagesPerChannel` | number | `300` | 单频道当天最多取回消息条数 |
| `personaPresetId` | string | `""` | **人格预设 ID**：`data/yesimbot/memory/core/` 下核心记忆块的文件名（不带 `.md`）或标题。**见下方专门说明** |
| `diaryGenerateRetries` | number | `7` | 日记生成失败最大重试次数 |
| `diaryGenerateRetryDelayMs` | number | `5000` | 生成重试间隔（毫秒） |

### P3 QQ 空间自动互动

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `interactionEnabled` | boolean | `true` | 是否启用自动互动 |
| `interactionIntervalMin` | number | `60` | 轮询间隔（分钟），使用 setTimeout 递归调度不堆积 |
| `interactionMaxWritesPerRound` | number | `5` | 单轮写操作（评论/回复）上限，串行执行 |
| `interactionPostsPerRound` | number | `10` | 单轮读取的动态条数上限（SDK 上限 20） |
| `interactionAllowUserIds` | string[] | `[]` | 互动白名单：仅与这些作者/评论者互动；留空 = 不限制 |
| `interactionStateRetentionMs` | number | 7 天 | 内存状态（水位、已见评论）保留时长，超期清理 |

### 发布与其它

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `publishImageConcurrency` | number | `3` | 图片下载并发数上限 |
| `publishMaxImageBytes` | number | `32MB` | 单张图片大小上限 |
| `alertTargets` | string[] | `[]` | “结果不确定需人工核对”的私聊通知目标 userId；留空仅输出 warn 日志 |
| `debug` | boolean | `false` | 开启后输出完整提示词与响应；关闭时仅 warn/error |

---

## `personaPresetId` 填写说明

该字段用于在生成日记时注入**人格设定**，指向 YesImBot 核心记忆文件：

```
data/yesimbot/memory/core/
```

- 找到该目录（一般位于启动 Koishi 的工作目录下），例如其中的文件：
  - `persona.md`（文件内标题为 `# 我是谁`）
  - `habits.md`（文件内标题为 `# 生活习惯`）
- 填写值为：
  - **文件名（不含 `.md`）**，例如 `persona`；或
  - **文件内标题**，例如 `我是谁`
- 留空：按默认自然风格生成，功能不受影响；
- 填了但找不到对应记忆块：插件会告警并按默认人格继续。

> 提示：也可以先通过 YesImBot 的记忆管理功能创建核心记忆块，再在这里填它的名称。

---

## 指令用法

### `qzone.feeds [条数] [-t QQ]`

读取 QQ 空间动态列表（发布时间、作者昵称、正文摘要、点赞/评论数）。

```text
qzone.feeds            # 读取机器人自己的 5 条动态
qzone.feeds 10         # 读取 10 条
qzone.feeds 5 -t 123456 # 读取指定 QQ 的公开动态 5 条
```

### `qzone.publish <内容>`

发布文字动态到机器人自己的 QQ 空间。

```text
qzone.publish 今天天气真好，出门散步了 ☀️
```

### `qzone.status`

查看登录态状态（协议、账号、在线状态、Cookie 有效性、自动续绑健康）。

```text
qzone.status
```

> 三条指令都受 `allowUserIds` 白名单控制。

---

## 模型工具：`qzone_publish`

YesImBot 的模型会在会话中自动看到并调用此工具，例如模型收到：

> “把这张图发到空间，配文：周末愉快！”

会调用 `qzone_publish({ content: "周末愉快！", images: ["图片地址"] })` 完成发布。

- `content`（必填）：正文/配文；
- `images`（可选，最多 9 张）：http(s) 链接、`data:` 或本地路径，单张 ≤32MB。
- 白名单外的会话，该工具对模型不可见。

---

## 每日记忆动态（P2 工作原理）

1. 每天 `diaryTime`（默认 23:00）触发；
2. 从 WorldStateService 采集**当天**记忆（优先 L3 已归档日记，否则 L1 当天消息）；
3. 结合 `personaPresetId` 人格 + `mainModel` 生成第一人称日记（100~200 字）；
4. 自动发布到 QQ 空间。

规则：当天无记忆则跳过；生成失败重试最多 7 次、间隔 5 秒；发布结果不确定时**绝不自动重发**，只通知 `alertTargets` 人工核对；停机/重载错过触发时刻不补发。

---

## 自动互动（P3 工作原理）

1. 按 `interactionIntervalMin`（默认 60 分钟）轮询（setTimeout 递归，不堆积）；
2. 拉取好友新动态与机器人自己动态下的新评论；
3. 把正文/评论交给 `subModel` 决策是否评论/回复；
4. 单轮写操作不超过 `interactionMaxWritesPerRound`（默认 5）且串行执行；
5. 所有水位、已见评论仅存内存，重启清空且不补扫；每条动态只决策一次。

---

## 常见问题

**Q：`qzone.*` 指令提示“你没有权限”？**
A：把你的 QQ 加到配置 `allowUserIds`；留空时只有超级管理员可用。

**Q：`qzone.status` 显示“未获取登录态”？**
A：确认同实例有已登录的 OneBot/Milky 机器人，并允许 `get_cookies` 调用。

**Q：日记没发布？**
A：检查 `diaryEnabled`、当天是否有记忆、`mainModel` 模型组是否可用。发布结果不确定时请到 QQ 空间人工核对（消息会走 `alertTargets` 或日志）。

**Q：会重复发布吗？**
A：不会。所有写操作遵循确定性结果语义：请求发出后结果不确定时不自动重发，只提示人工核对。

---

## 技术特性

- TypeScript + Koishi v4，全部配置由 Koishi Schema 声明；
- 通过 YesImBot `@Extension` / `@Tool` 注册为扩展与模型工具；
- 登录态按域名缓存、好友动态列表缓存 30 秒、`get_cookies` 单飞防风暴；
- 续绑失败指数退避（60s→300s），连续失败 3 次停止自动续绑；
- 图片下载/上传并发受限，避免打满带宽；
- 日志分级：`debug` 关闭时仅 warn/error 输出；
- 内存状态定期清理，插件卸载完整释放定时器与缓存。

---

## 开源协议

MIT