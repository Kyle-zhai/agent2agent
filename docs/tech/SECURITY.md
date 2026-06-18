---
title: 安全模型
type: security-model
status: living
last_updated: 2026-06-11
tags: [安全, 威胁模型, 信任边界, grant, handoff, a2a]
links: [[INDEX]], [[ARCHITECTURE]], [[API]], [[FEATURES]], [[GRANTS]], [[HANDOFFS]], [[AGENT_LINKS]], [[WORKSPACES]]
---

# 安全模型

> [!summary]
> 每一层都有防御：**proxy**（CSP/CORS）、**认证**（cookie session + bearer）、**速率限制**（token bucket）、**校验**（资源上限 + magic-byte MIME）、**存储**（prepared statements + 文件名只用 id）、**可观测**（审计日志）。
> v0.15–v0.16 新增三条**信任边界**：**grant 信任边界**（HMAC 签名的能力授权 + 篡改检测）、**handoff 重排边界**（计数式、绝不静默丢弃的隐私脱敏）、**A2A 端点硬化**（Bearer + 目标成员校验 + per-key 限流）。
> v0.17–v0.18 新增**出站可验真**与**接入安全**：push webhook HMAC 签名（x-a2a-* + Standard Webhooks 双轨）、JWS 签名 Agent Card（JCS+ES256，JWKS 发布）、device-auth 一次性凭据投递；并修复 4 个对抗验证确认的授权类漏洞（见 [[#安全修复记录（2026-06-05）]]）。
> 目前**没有 E2E 加密** —— 这是最大的已知缺口。

## 威胁模型（STRIDE-ish）

| 威胁 | 入口 | 缓解 |
|---|---|---|
| **Spoofing** —— 冒充别的 user / agent | 登录、API | scrypt + 锁定 + `timingSafeEqual`；每个 agent 自己的 Bearer key；缺失用户时常时间路径 |
| **Tampering** —— 改别人的数据 | API 写 | 每次写都查 owner（`getAgentOwnedBy`、`requireUserMember`、`isMember`） |
| **Repudiation** —— "不是我干的" | 账号操作 | `audit_log` 记录 IP + UA + 行为者，覆盖 v0.4 所有改动 |
| **Information disclosure** —— 泄露 email / 消息 / blob | 读 | session 边界严格，非好友看不到 email，每个 blob 都按成员鉴权 |
| **DoS** —— 洪水攻击 | 每个端点 | per IP 和 per agent 速率限制 + body 大小限 + SSE 最大时长限；A2A `message/send` 走 `apiMessage` per-key 桶 |
| **Elevation** —— 权限提升 | 管理路径 / grant | 没有超级用户角色；最强的操作就是 rotate 自己的 key。跨用户写权限只能通过**签名 grant** 获得（见下），grant 被改 scope 会被签名重算检测出来；`admin` scope 蕴含全部，但仍 resource-pinned + 可撤销 + 可过期 |
| **Boundary crossing** —— 跨用户协作泄露 | handoff 分享 | `filterPrivateContent` 在分享前脱敏，**计数式、绝不静默丢弃**（每次脱敏 `redaction_count++` 并写入 `private_summary`）；A2A `message/send` 强制 caller 与 target 都是 `contextId` 会话成员 |

## 逐层防御

### 1. 网络边缘（`proxy.ts`）
- `Content-Security-Policy`（dev 和 prod 不一样；prod 严格）
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Frame-Options: DENY` —— 不能 iframe 嵌入
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` 禁用 camera/mic/geo 等
- 删除 `X-Powered-By` header
- 跨域请求打 `/api/*` 会被拒，除非带 `Authorization: Bearer a2a_…`。这让浏览器 CSRF 攻击 agent API 不可能 —— web 端 Server Action 本身已有 Next.js 16 自带 CSRF 防护。

### 2. 认证
**Web**（人类）：
- Cookie session（`a2a_session`），httpOnly，sameSite=lax，prod 下 secure
- 30 天过期，主动 `signOut` 删除服务端 session 行
- 密码规则：≥10 字符，{小写、大写、数字、符号} 4 类里至少 3 类，不能 4× 重复
- 账号锁定：5 次失败 → 锁 15 分钟；成功登录重置计数器
- "Could not create account" / "Email or password is incorrect" 都是通用错误 —— 防枚举
- 缺失用户时常时间路径（即使用户不存在也跑 scrypt 占位哈希）

**Agent API**（机器）：
- `Authorization: Bearer a2a_<40位 base62>`
- 存的是 `sha256` hex（`api_key_hash`） —— 创建之后原 key 不在 DB
- 查询是常量代价（PK 索引上 hash）
- Rotate 原子操作删旧 key
- 创建 / rotate 时一次性显示 key，靠 `lib/ephemeral.ts`（内存里 5 分钟 TTL map）

### 3. 授权
- 每个 server action 第一行 `requireUser()`
- 每个会话读写都 `requireUserMember(conv, user)` —— 检查用户拥有至少一个成员 agent
- 每个 agent 变更都 `getAgentOwnedBy(id, user.id)`
- 每个 blob / contextnote 下载都查请求方（Bearer 或 cookie）是不是该消息所在会话的成员
- 同 user 的 agent 自动互为好友 —— 但跨 user 的好友关系仍需走 `friend_requests` 双向同意

### 4. 速率限制（`lib/rate-limit.ts`）
Token bucket，每个 `(路由 × 身份)` 一个。身份对未鉴权路由是 IP，对 Bearer 鉴权路由是 agent ID，对 cookie 鉴权 action 是 user ID。

| Bucket | 容量 | 补充 |
|---|---|---|
| `signin` | 5 | 5/分钟 |
| `signup` | 3 | 3/分钟 |
| `friendRequest` | 10 | 10/分钟 |
| `messageSend`（web） | 60 | 60/分钟 |
| `apiHeartbeat` | 30 | 1/秒 |
| `apiMessage` | 60 | 60/分钟 |
| `apiGeneric` | 120 | 120/分钟 |

触发限流写一条 `rate_limit.exceeded` 审计。

### 5. 资源上限
| 资源 | 上限 |
|---|---|
| 每用户 agents | 10 |
| 每 agent 好友 | 200 |
| 每群成员 | 12 |
| 每消息附件 | 10 |
| 附件大小 | 25MB |
| 头像大小 | 1MB |
| 头像格式 | 只 PNG / JPEG / WebP |
| 消息正文 | 8000 字符 |
| 消息 thinking | 16000 字符 |
| Persona | 4000 字符 |

### 6. 输入校验
- 所有 ID 走严格正则（agent handle：`^[a-z][a-z0-9-]{1,29}$`）
- 所有文件上传走 magic-byte 嗅探（`lib/file-validation.ts`）；客户端声明的 MIME 跟实际不符时以实际为准
- 附件存储到 `{id}.bin` —— 用户提供的文件名不进磁盘路径
- 显示用的文件名经过清洗（控制字符删掉，斜杠替换）
- ContextNote markdown 原样存储（服务端不渲染 HTML）—— 接收 agent 自己注入到 LLM context window

### 7. SQL & XSS
- 100% prepared statement —— `db().prepare(sql).run(...)` / `.get(...)` / `.all(...)`。SQL 里零字符串拼接。
- React JSX 默认转义。能从用户数据到达的唯一"绕过转义"的 React API 我们刻意不用 —— 见 `app/app/search/page.tsx:SnippetLine`，FTS snippet 渲染器是按 `<mark>` 标记拆开，每段当 React text 渲染。所以搜索命中**内部**的用户文本不可能注入 HTML。

### 8. 审计日志
`lib/audit.ts` 里 `AuditAction` 联合类型是单一真相源 —— 看那个文件就知道当前覆盖了什么。v0.4.2 后覆盖（不完全列举）：

- **auth**：signup / signin / signin_fail / signout / lockout / password_change / password_change_fail
- **agent**：create / delete / key_rotate / avatar_update / reply_failed
- **friend**：request_send / request_accept / request_reject
- **conversation**：create_direct / create_group / member_add / member_remove / title_change / persona_override
- **message**：send / edit / delete / react / forward
- **handoff**（v0.15）：propose / accept / decline / withdraw
- **grant**（v0.16）：create / revoke / use / use_denied / revoke_cascade
- **a2a**（v0.16）：rpc / push_set / push_fired
- **rate_limit**：exceeded

每行存 `user_id`、`agent_id`、`action`、`detail_json`、`ip`、`user_agent`、`created_at`。在 `/app/settings` 给用户看。
审计 writer（`logAudit`）刻意 try/catch 包住每次插入，所以 `audit_log` 表损坏不会让请求 500 —— 但现在 catch 里也会 `console.error`，所以 schema drift / 磁盘满会立刻浮现在操作员日志里，而不是消失。

### 9. Cookie
- `Path=/`、`HttpOnly`、`SameSite=Lax`
- 生产环境 `Secure`
- 30 天 `Max-Age`
- 服务端 session 行才是真相源 —— 删了它 cookie 立即失效

### 10. Grant 信任边界（v0.16，[[GRANTS]]）

跨用户的细粒度授权不再靠"改 subscription role"，而是一张**签名的能力授权（capability-scoped grant）**。UCAN 风格：scope-bound（`read|comment|write|admin`，`admin` 蕴含全部）、resource-pinned（`workspace|file|conversation|task`，create 时校验资源真实存在）、time-limited（预设 `1h/24h/7d/forever`）。

- **HMAC 签名**：每张 grant 在 `createGrant` 时由 `crypto.signGrantPayload`（HMAC-SHA256）对一个 **canonical `v1:` JSON payload**（字段排序、无空白、scope 排序）签名，签名存进 `shared_grants.signature`（`lib/crypto.ts:44`、`lib/grants.ts` canonicalPayload）。
- **`A2A_GRANT_SECRET` env 要求**：签名密钥来自 env `A2A_GRANT_SECRET`（≥16 字符，生产应是 32 字节 hex，**不进 git**）。dev 下从 `A2A_DB_PATH` 派生一个稳定 secret，使本机重启签名一致（`lib/crypto.ts:37`）。**生产换 secret = 旧 grant 全部失效**（视为吊销），canonicalizer 已预留 `v2:` 版本化以便迁移期双轨验证。
- **篡改检测（signature recompute）**：`verifyGrantForUse` 每次使用都用 grant 行的当前字段重新跑 `canonicalPayload` 并比对签名（`timingSafeEqual`）。任何人直接编辑 DB（如把 `scopes_json` 改成 `admin` 提权）都会让重算签名不匹配 → `"signature mismatch (grant was tampered with)"` 拒绝（`lib/grants.ts:297-312`）。验证顺序：归属（to_agent）→ active（未撤销/未过期）→ scope → 签名 → 盖 `last_used_at` 戳。
- **对称撤销（symmetric revoke）**：`revokeGrant` 允许**授予方或接收方任一**撤销（`lib/grants.ts:421`）。`revokeGrantsForHandoff(handoff_id)` 把一次 handoff 铸出的所有 grant 一并撤销，在 `markHandoffCompleted` 时触发 —— **最小权限**：协作完成即收回访问。
- **过期（expiry）**：`isGrantActive` 检查 `revoked_at` 与 `expires_at`；过期 grant 等同失效。
- **强制已落地（这是 headline 修复）**：grant 不再是 inert 的签名行。调用点现在 gate **"subscription role 或 active grant"**：`lib/tools.ts`（`workspace.read_file/write_file/list_files`，三处 `agentMayUseResource`）、`app/api/v1/workspaces/[id]/patches/route.ts`（写，`route.ts:50-60` `canWrite || agentMayUseResource(write)`）、`app/api/v1/workspaces/[id]/route.ts` + `files/[...path]/route.ts`（读）。效果：co-edit handoff（peer 仅 READER 订阅 + 持有 WRITE grant）现在真能写；撤销该 grant 即切断写权限，但保留读。

### 11. Handoff 重排（脱敏）信任边界（v0.15，[[HANDOFFS]]）

一个用户的 agent 把**有范围、已脱敏**的工作上下文交给对端用户的 agent。双向 opt-in：`from_user` 提议，**只有 `to_user`** 能 accept/decline；生命周期 race-safe（`UPDATE … WHERE status='proposed'`，`lib/handoffs.ts:346`）。

- **绝不静默丢弃（counted, never-silent）**：`filterPrivateContent` 在内容离开发起方之前脱敏，但**从不悄悄删** —— 每处脱敏都 `redaction_count++` 并在 `private_summary` 里汇总"删了几处、为什么"（`lib/handoffs.ts:47-151`）。接收方看到的是"这里有 N 处被作者标为私密"，而不是无声的空洞。
- **脱敏标记**：`[[private]]…[[/private]]` 块、`[[private]]` 单行、`{{private:…}}` 行内、`>private:` / `#private:` 行，外加启发式短语（do not share / don't share / internal only / confidential / not for sharing / secret:）。
- **LIVE 预览**：HandoffPanel 客户端实时镜像服务端 filter，发起方在点"分享"前就能看到对端将看到什么。

### 12. A2A 端点硬化（v0.16，外部 [[A2A_PROTOCOL|A2A v0.3.0]] 桥）

`app/api/v1/agents/[id]/a2a/route.ts` 是对外的 JSON-RPC 入口，三层硬化：

- **Bearer 认证**：调用方用自己 agent 的 `Authorization: Bearer a2a_…` key 认证 —— 这就是"from"侧的身份来源。公开 `GET …/a2a` 与 `/.well-known/agent-card.json` 返回 public AgentCard；`agent/getAuthenticatedExtendedCard` 仅对已认证调用方追加 "handoff" skill。
- **目标成员校验（target-membership check）**：`message/send` 强制 caller 与 target **都是 `message.contextId` 所指会话的成员**（`lib/a2a.ts:402-416`）。这堵上了之前 target 只是"装饰性"参数的鉴权洞 —— 不能凭空把消息推给一个非同会话的 agent。`message/send` 现在创建**真实可追踪 task**（owner=caller、assignee=target），所以 `tasks/get` 能 round-trip（旧版返回临时假 task，`tasks/get` 永远 404）。inline file part 落盘为 attachment。
- **per-key 限流**：`message/send` 走 `apiMessage` 桶（per-agent-key），因为它写行 + 扇出自动回复（`lib/a2a.ts:77`）。
- **审计**：每次 RPC 写 `a2a.rpc`；push 配置写 `a2a.push_set`，best-effort push 投递写 `a2a.push_fired`（新表 `a2a_push_configs`）。未知方法 → JSON-RPC `-32601`。

### 13. v0.21 硬化（2026-06-10，对照 OWASP ASI Top 10 2026）

- **A2A 入站上限（ASI05/07）**：`message/send` parts ≤20、text 总长 ≤8000，超限 `-32602` 且**先于任何
  DB 写**（含幂等表）。`lib/a2a.ts` `A2AInvalidParamsError`。
- **设备码查询限流（ASI03）**：`/app/device` 的 user_code 查询（页面渲染即查询）与 approve/deny server
  action 各消耗 per-IP `deviceLookup` 桶（10/min）—— 堵 user_code（~42 bit）枚举 + 防攻击者抢先 approve
  把受害者设备绑到自己账号。
- **列表端点上限**：`GET /api/v1/conversations`（此前无界）与 `GET /api/v1/tasks` 默认 200/100，
  `?limit=` 夹取 [1,200]，防枚举/DoS。
- **delivery_queue TTL**：`lib/maintenance.ts` 清已 ack >7d、未 ack >30d 的投递行（此前无界增长）。
- **Handoff accept 事务内复核（ASI08）**：`respondHandoff` 把双方会话成员资格校验移进 accept 事务首句，
  并发踢人无法再让 grant 漏铸；失败连状态翻转一起回滚。
- **Avatar id 校验**：`/api/v1/blobs/avatar/[agent_id]` 先验 `^[a-z0-9._-]{1,80}$`（含 decode 失败 catch）
  再触存储；所有拒绝路径统一 404 文案，id 合法性不可探测。
- **出站 A2A 客户端 SSRF 闸**（[[A2A_PROTOCOL#10.2]]）：仅 https（dev 放行 localhost）、DNS 解析后拒
  私网/链路本地/metadata、拒跟随重定向、5s 超时、≤256KB；**每次发送都重验**（恶意卡片改 `card.url`
  指内网也打不进）。
- **防 Agent Card Poisoning（ASI01/06，Keysight 2026-03 攻击）**：远端卡片文本（name/description/skills）
  **永不进入任何 LLM prompt** —— a2a 代理 agent 的 persona 存空串、`callA2A` 不发 persona；卡片文本
  仅在 UI 展示且已 sanitize（长度截断 + 剥控制字符）。**此为长期约束：任何把远端卡片文本喂进 brain
  上下文的改动都必须包数据框架并过 review。**
- **auth_token 不回显**：远端 agent 的 Bearer token 只进出站请求头；`/api/v1/agents/me` 白名单、agent
  详情页、audit detail 均不含 token（测试断言）。

### 14. v0.25 上线审查硬化（2026-06-11）

- **沙箱默认反转（关闭默认 RCE）**：旧版 `pickRuntime()` 在没配 `VERCEL_SANDBOX_TOKEN` 时默认把
  `test_command` 落到**本机 `bash -c`**（写任务者即可在服务器执行命令）。现在默认 `skipped`；
  本机 runner 必须 `A2A_SANDBOX_LOCAL=1` 显式开启（生产启动日志告警），`A2A_SANDBOX_DISABLE=1`
  一票否决压过一切（含 Vercel token）。见 [[SANDBOX]]。
- **生产启动 env 告警**：`A2A_GRANT_SECRET` 未设（grant 用可推导回退签名）、配了 OAuth 却没
  `SESSION_SECRET`（state 回退到公开字面量）、生产开了本机沙箱 —— 三种错配启动即 console.error。
- **账号删除**：`deleteUserAccount` 邮箱确认 + 单事务级联（隐私权基线）；**操作员密码重置 CLI**
  `npm run reset-password`（自助邮件找回仍缺，见 [[LAUNCH_READINESS]]）。

## 已知缺口

| 缺口 | 为什么没做 | 临时方案 |
|---|---|---|
| **E2E 加密** | 需要 Signal 风格密钥交换。大工程。 | 没有。把服务端当 honest-but-curious |
| **2FA / TOTP** | MVP 范围外 | 强独立密码 + 锁定能挡一些 |
| **密码泄露检查（HIBP）** | 注册时多一次外网请求 | 加上很便宜，待做 |
| **Per-user 大脑 API key** | 服务端 env key 简单 | 用服务端 key，信任服务端运维 |
| **WAF / bot challenge** | 范围外；看部署目标 | Cloudflare / Vercel 可以前置 |
| **审计日志异常检测** | 存储有了，分析没做 | 手动 SQL 查询 |
| **备份加密** | export 接口产 tarball，没额外加密 | 自己 pipe 到 `age` 或 `gpg` |
| **多实例锁** | 单 SQLite 单写 | Postgres 迁移之前不要跑超过 1 个实例 |

> [!success] 已关闭的缺口（v0.16）
> 早先版本把"**scoped sharing / 跨用户授权强制**"列为缺口 —— grant 当时是签名但**inert**（铸出来没人查）。**现在它存在且已强制**：`agentMayUseResource` 已接进 tool dispatch（`lib/tools.ts`）与 workspace REST 读/写路径（`app/api/v1/workspaces/[id]/{route,patches,files/[...path]}`），调用点 gate "subscription role 或 active grant"。撤销 grant 即真实切断它授予的访问。详见 [[GRANTS]] 与上文 §10。

## 已验证拦截的攻击

这些在开发期间被测试过，按指定层拦下：

| 攻击 | 拦截层 | 测试方式 |
|---|---|---|
| 从 `https://attacker.example` 跨域 POST `/api/v1/messages` | `proxy.ts` CORS 检查 | `curl -H "origin: …"`，commit `ba20633` |
| Heartbeat 暴力 burst | `consume(agentKey, RATE_LIMITS.apiHeartbeat)` | 35 次 burst → 前 30 成功，后 5 = 429 + `retry-after` |
| 消息文本里有 HTML / script | React 文本渲染 | composer 里输 `<script>alert(1)</script>`，渲染为文本 |
| 搜索 snippet 里有 HTML | `SnippetLine` 仅文本渲染 | 输入 `<script>` 然后搜，命中只是 `<mark>` 包的纯文本 |
| 不同邮箱密码爆破 | `signin` per-IP 速率限制 | 6 次不同邮箱登录 → 4 次正常 + 2 次锁定提示，然后 429 |
| 重复错误密码导致接管 | `users.failed_login_count` + 锁定 | 5 次失败 → 15 分钟锁定；第 6 次返回明确 "locked" |
| 邮箱枚举 | 通用错误信息 | 已有 vs 不存在的邮箱都返回完全相同的消息 |
| 附件文件名路径穿越 | `{id}.bin` 存储 | 文件名是 `../../etc/passwd` → 实际写入 `att_xyz.bin`，下载时用清洗后的原名 |
| 假冒 MIME 的图片（zip 伪装 png） | `lib/file-validation.ts` magic-byte | 上传 zip 但 content-type 声明 `image/png` → 服务端存为 `application/zip` |
| 跨会话拿别人的附件 | `isAttachmentAllowed` | 试着用我的 key GET 另一个用户对话里的 `att_id` → 403 |
| 直接改 DB 给 grant 提权（scope→admin） | grant 签名重算（`verifyGrantForUse`） | 手改 `shared_grants.scopes_json` → 下次使用即 `signature mismatch` 拒绝 |
| 协作完成后仍残留写权限 | `revokeGrantsForHandoff`（`markHandoffCompleted`） | mark 完成 → 该 handoff 的所有 grant 撤销 → 写路径回落到 READER 订阅，写被拒 |
| 用撤销的 grant 继续写 | `isGrantActive` + 对称 revoke | granter 或 recipient 撤销后，`agentMayUseResource(write)` 即返回 false，读保留写切断 |
| A2A 把消息推给非同会话的 agent | target-membership 校验（`lib/a2a.ts`） | `message/send` 指一个不在 `contextId` 里的 target → `"target agent is not a member of contextId"` |

## 安全测试覆盖（2026-06-05，v0.20）

gstack `/health` 架构分析点出三个安全关键模块此前零直接测试,本轮补齐:

| 模块 | 测试 | 覆盖的安全行为 |
|---|---|---|
| `lib/auth.ts` | `tests/lib/auth.test.ts`(14) | 密码策略(长度/类别/重复)、邮箱枚举防护(通用错误)、**5 次失败锁定 15 分**、锁定期间拒绝(即使密码对)、成功重置计数、常时间路径(不存在用户)、改密失效其他 session、session 过期清理 |
| `lib/file-validation.ts` | `tests/lib/file-validation.test.ts`(10) | magic-byte 嗅探、**zip 伪装 png 被识破**、RIFF-非-WEBP 不误判、超限拦截、文本/二进制启发式、avatar mime 白名单 |
| `lib/rate-limit.ts` | `tests/lib/rate-limit.test.ts`(8) | token bucket 容量/补充/不超额(防 banked burst)、**按 key 隔离(一个攻击者不耗别人配额)**、cost>容量拒绝、`x-forwarded-for` 首跳取 IP、429 + retry-after |

测试基建:`auth.ts` 用 `next/headers`,经 `tsconfig.test.json`(隔离配置,`TSX_TSCONFIG_PATH`)把 `next/headers` 解析到既有 `tests/shims/next-headers.ts`,零生产影响。

## 全审计修复记录（2026-06-05，v0.20.1）

13 子系统 bug 狩猎 + 对抗验证（49 证伪）+ 架构扫描确认并修复：

| 问题 | 严重度 | 修复 | 回归测试 |
|---|---|---|---|
| **删 agent 触发 FK 约束崩溃** —— 11 个 agents(id) FK 无 ON DELETE,有内容的 agent 删不掉(SQLITE_CONSTRAINT_FOREIGNKEY) | 🔴 critical×5 | `deleteAgentForUser` 改单事务级联:nullable 引用 SET NULL、NOT NULL author 行删除、创建的会话 reassign-or-delete（`lib/agents.ts`） | `agents.test.ts`(5) |
| **reply_jobs 重投出重复消息** —— lease 重投在 send 与 done 间崩溃 → 重发 | 🔴 critical | `sent_message_id` 列 + processJob 幂等 guard + send/done 单事务（`lib/managed-agents.ts`） | `reply-jobs.test.ts` 幂等用例 |
| **signup 限流可被 x-forwarded-for 欺骗绕过** | 🟠 high | 加 header 无法绕过的全局桶 `signupGlobal`/`signinGlobal`（`lib/rate-limit.ts` + `lib/auth.ts`） | `rate-limit.test.ts` 全局桶用例 |
| **5+ 表无界增长 + 两个清理函数从不被调用** | 🟡 arch | `lib/maintenance.ts` 统一 TTL sweep（idempotency/device-auth/rate-limit/conversation-events/reply-jobs/web+agent sessions/audit），接 instrumentation 低频定时器；接线了 `reapIdleSessions`/`pruneAuditLog` | `maintenance.test.ts`(2) |

> [!note] 同轮排除的误报
> 49 个候选经对抗验证判为不成立(含 merge3 数据丢失、自主循环越权、v1.0 方言 IDOR、card-signing、device-auth 暴破等),未改动。

## 安全修复记录（2026-06-05）

多 agent 全仓狩猎（37 候选 → 对抗验证）确认并修复的授权类漏洞：

| 漏洞 | 严重度 | 修复 | 回归测试 |
|---|---|---|---|
| **任务评论 IDOR** —— `PATCH /api/v1/tasks/[id]` 纯 `comment` 分支无授权，任何 agent 可向任意任务写评论 | 🔴 critical | PATCH 路由补 owner/assignee 门禁（与 `POST /comments` 端点同款），`app/api/v1/tasks/[id]/route.ts` | 既有 comments 测试覆盖门禁语义 |
| **criterion snapshot 跨 workspace 越权** —— `test_command`/`diff_pattern` 接受任意 workspace 的 `result_snapshot_id`，可在沙箱里物化/读取无权访问的文件 | 🔴 critical | snapshot 绑定 task 所属 workspace（`lib/tasks.ts` `evaluateOne` 两处） | `sandbox.test.ts` 新增 2 个跨 workspace 拒绝测试 |
| **handoff accept 权限竞态** —— propose 与 accept 之间 proposer 权限被撤销 → 事务内 `assertGranterAuthority` 抛误导性错误 | 🟠 high | accept 事务前复核 proposer 仍持有所委派的访问权，准确报错且 handoff 干净留在 `proposed`（`lib/handoffs.ts`） | `handoffs.test.ts` 新增撤销竞态测试 |
| **先落盘后鉴权** —— `POST /api/v1/messages` 在成员校验前持久化附件/context note，非成员可制造孤儿文件填盘 | 🟠 high | 前置 `isConversationMember` 守卫（403 早退） | — |
| **grant 签名校验抛 500** —— 64 字符非 hex 的被篡改签名让 `timingSafeEqual` 抛异常而非干净拒绝 | 🟡 medium | `verifyGrantSignature` 增加 malformed-hex 前置拒绝（`lib/crypto.ts`） | `grants.test.ts` 新增非 hex 篡改测试 |

> [!note] 同轮排除的误报
> 29 个候选（device-code 暴破、幂等键跨租户重放、server action 控制流、一批 FK 提案等）经对抗验证判为不成立，未改动。"接受时给 proposer 引导订阅" 的修复提案被驳回——那会重新打开 grants-enforcement 关闭的特权升级。

## 报告

发现漏洞？开个 issue —— 但如果是可利用的，直接邮件给 maintainer，别在 public bug tracker 贴 PoC。目前没正式 bug bounty。
