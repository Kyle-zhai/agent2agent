---
title: 上线就绪报告 — "能直接给真实用户用"逐项核查
type: audit
status: living
last_updated: 2026-06-11
tags: [上线, 就绪, 审查, 安全, 运维, 产品]
links: [[INDEX]], [[SECURITY]], [[OPERATIONS]], [[STATUS_REPORT]], [[UX_AUDIT]], [[ROADMAP]]
---

# 上线就绪报告（2026-06-11）

> [!summary] 结论
> **可以上线的形态：自托管单实例 + 受邀/小规模真实用户（closed beta）— GO。**
> **开放注册的公开服务 — 还差临门**：邮件能力 **已交付（v0.26）**——自助密码找回 + 邮箱验证 +
> 可插拔零依赖 mailer（console/resend/webhook）。剩下两件结构性事情：**SQLite 单写入**（几十并发即
> 写竞争）与 **LLM 成本边界**（注：选了"本地 agent 接自己的 AI"后此项大幅降级，仅托管 agent 受影响）。
> Postgres 迁移步骤在 [[OPERATIONS]]。
>
> 审计方法：两路独立审查（安全/运维 + 产品完整性）逐项对码取证，**3 个阻塞项当场修复**
> （见下），终态 **402/402 测试、tsc/build 干净**。

## 一、本次审查发现并已修复的阻塞项 ✅

| # | 阻塞项 | 修复 |
|---|---|---|
| 1 | **沙箱默认在主机执行命令（RCE）** — `pickRuntime()` 在没配 `VERCEL_SANDBOX_TOKEN` 时默认落到本机 `bash -c`，task 的 `test_command` 完全由写任务的人控制 → 任何 beta 用户可在服务器上执行任意命令 | **隔离改为显式 opt-in**：默认 `skipped`（criteria 显式报不通过原因）；`VERCEL_SANDBOX_TOKEN` → 隔离执行；本机 runner 必须 `A2A_SANDBOX_LOCAL=1` 显式开启（生产启动日志告警）；`A2A_SANDBOX_DISABLE=1` 一票否决压过一切。+3 测试 |
| 2 | **忘记密码 = 永久锁死**（无邮件能力，无任何找回路径） | 运营兜底：`npm run reset-password -- <email> <新密码>` 操作员 CLI（复用注册同等强度校验 + scrypt，重置后清锁定计数、吊销全部会话、写审计），登录页加一行提示。冒烟测试全路径通过。自助邮件找回仍排期（依赖邮件服务商） |
| 3 | **无法删除账号**（个人数据无法清除） | `deleteUserAccount(userId, confirmEmail)`：邮箱确认门 + 单事务级联（逐 agent 走既有删除级联 → sessions / oauth_identities / invite_links / 审计行 / users 行），Settings 页新增 Danger zone（输入邮箱确认 + 登出跳转）。+8 测试（含双用户隔离断言、grant/handoff 不悬挂断言） |

附带修复：生产启动校验（`A2A_GRANT_SECRET` 未设 / 配了 OAuth 却没 `SESSION_SECRET` / 生产开了本机沙箱 → 启动日志大声告警）；favicon（`app/icon.svg`）。

## 二、达标项 ✅（取证后确认，可放心）

**认证与账号**：scrypt + 盐 + 常时间比对、强度策略、5 次锁定 15 分钟、防枚举错误文案、改密码吊销其他会话、数据导出完整（含 blob）。
**滥用防护**：注册/登录 per-IP + 常量键全局双桶（伪造 XFF 无法绕过）、设备码查询同样双桶、消息/心跳/工作区读写全部限流、附件 25MB×10 + magic-byte 嗅探。
**权限与隐私**：grant 真强制（铸造验权 + 使用时验签 + 双方可撤 + handoff 完成级联回收）；邮箱对其他用户零泄露（联系人/搜索/API/A2A 卡全查过）；私聊 dock 真私有；脱敏交接计数式永不静默。
**协作闭环**：邀请链接全流程、群管理、handoff 可发现（面板 + Inbox 角标）、助手失败在房间内可见、reply 队列崩溃自愈（lease + 幂等）。
**工程卫生**：迁移幂等（ensureColumn）、无界表全有 TTL 清扫、出站 SSRF 闸完备、品牌 404/错误页/加载骨架齐全、**402/402 测试 + tsc + build 干净**。

## 三、开放注册前必须解决（结构性 NO-GO 项）

| 项 | 为什么挡 | 路径 |
|---|---|---|
| ~~**邮件能力**（自助密码找回 + 邮箱验证）~~ **✅ v0.26 已交付** | 真实用户必然忘密码；运营 CLI 只适合小规模熟人 | 接 Resend/SES 任一 + token 表 + 两个页面（~1-2 天） |
| **Postgres 迁移** | SQLite 单写入，几十并发写即竞争；进程内状态（reverse-RPC、一次性 key 展示）不支持多实例 | [[OPERATIONS]] 已写好 1:1 迁移步骤（~1 天 + 切换窗口） |
| **LLM 成本边界** | 服务端 key 替所有用户付费，只有 per-agent 4/min 冷却，无全局/每用户日上限 | 全局 + per-user 日配额（~半天），或 per-user key（[[ROADMAP]]） |

## 四、上线后尽快补的警告项（不挡 closed beta）

1. **存储配额**：无 per-user 总量上限（磁盘填满 DoS）— 加每用户字节数统计 + 上限
2. **已删消息的附件仍可下载**（blob 路由不查 `deleted_at`）+ 无 blob 垃圾回收
3. **监控/备份**：只有 `/api/health`；备份目前 = 操作员复制 `data/` + `blobs/`（写进 cron）
4. **运营韧性**：改邮箱不支持（UI 已诚实声明）、5 分钟后消息不可删、direct 会话不能退出
5. **Mock 大脑提示**：没配 LLM key 时助手回复是固定脚本，对用户的提示太隐晦
6. OAuth 注册跳过三步引导（email 注册才有）；移动端完整导航（见 [[UX_AUDIT]] backlog）

## 五、上线操作清单（closed beta，今天就能照做）

```bash
# 1. 生产环境变量（缺了启动会告警）
SESSION_SECRET=<32B 随机>           # 配了 OAuth 才必须
A2A_GRANT_SECRET=<32B hex>
ANTHROPIC_API_KEY=… 或 OPENAI_API_KEY+OPENAI_BASE_URL+OPENAI_MODEL
# 沙箱：保持默认（skipped）或配 VERCEL_SANDBOX_TOKEN；绝不在生产开 A2A_SANDBOX_LOCAL
# 2. 构建与运行
npm run db:init && npm run build && npm start
# 3. 备份 cron（SQLite + blobs 整目录）
# 4. 用户管理：邀请链接发放；忘记密码 → npm run reset-password
```

## 六、复审记录

- 2026-06-11 首次：双路审计 19 项发现 → 3 阻塞已修 / 6 警告留单 / 30+ 达标确认；终态 402/402。
- 2026-06-11 增补：**邮件能力交付（v0.26）** —— 自助密码找回（`/forgot`→`/reset`，一次性 token + 防枚举 + 重置吊销全部会话）、邮箱验证（`/verify-email`，`A2A_REQUIRE_EMAIL_VERIFICATION` 可选门禁）、零依赖可插拔 mailer（`lib/mailer.ts`：console/resend/webhook）。开放注册 NO-GO 从 3 项降为 2 项（Postgres + 成本边界）；+8 测试，终态 **435/435**。同时 §五操作清单的"忘记密码 → CLI"可改为用户自助 `/forgot`（CLI 仍保留为运营兜底）。
