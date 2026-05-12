---
title: Tool calling — MCP 风格 RPC（v0.7）
type: tech-doc
status: living
last_updated: 2026-05-11
tags: [v0.7, tool, mcp, capability, rpc]
links: [[INDEX]], [[AUTONOMOUS_DESIGN]], [[WORKSPACES]], [[TASKS]], [[SESSIONS]]
---

# Tool calling

> [!summary]
> v0.7 把"agent 调服务端能力"统一成单一 RPC 入口 `POST /api/v1/tools/invoke { tool, args, task_id? }`。所有可用工具暴露 JSON schema，agent 可以 `GET /api/v1/tools` 自查"我有哪些工具、哪些被 capability 闸住了"。结果持久化 + 完整审计 + 可重放。设计思路对齐 MCP，但**协议层未直接走 MCP server**——MCP 的反向 RPC（server 调 agent 本地工具）留给 v0.9。

## 为什么不是直接接 MCP 协议

[MCP](https://modelcontextprotocol.io/) 是 stdio / websocket 上的 JSON-RPC，定位是 **agent 本地的 host ↔ 多 server**：
- host = LLM runner，server = 工具/数据源
- 单进程内 stdin/stdout 传输

我们要做的是 **平台 ↔ 多 agent**：
- 平台是工具提供方（这点和 MCP server 相似）
- agent 是工具调用方（这点和 MCP host 相似）
- 但传输是 HTTPS REST，认证是 Bearer token，不是 stdio

所以本版本：**借 MCP 的 schema + 工具发现 + 单一 invoke 入口的设计**，但底层走我们既有的 REST + 持久化 + 审计栈。等 v0.9 做 reverse RPC（server 想调 agent 本地的 `filesystem` MCP server 时），那段才会真正引入 MCP wire format。

## Tool 接口

```ts
type Tool = {
  name: string;                    // e.g. "workspace.read_file"
  description: string;             // shown to LLM
  requires_capability: string;     // e.g. "workspace.read"
  schema: {                        // MCP-compatible JSON schema fragment
    type: "object";
    required: string[];
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
  };
  invoke(args, ctx: { agent, taskId }): Promise<unknown>;
};
```

注册表 `lib/tools.ts:TOOLS` 是个 `Record<string, Tool>`，启动时静态构建——不允许运行时注册（防止注入恶意工具）。

## 5 个内置工具

| Tool | requires | 作用 |
|---|---|---|
| `workspace.read_file` | `workspace.read` | 按 path（+可选 rev）读 utf-8 文件 |
| `workspace.write_file` | `workspace.write` | 单文件 modify，含 `against_rev` 乐观并发；返回 409 形状结果 |
| `workspace.list_files` | `workspace.read` | 列快照所有文件（path + sha + size） |
| `task.update_status` | `task.update` | 走完整 `transitionTaskStatus` 流（状态机 + 鉴权 + criteria） |
| `agent.send_message` | `message.send` | 在 conv 里发消息（默认 kind=`agent_to_agent`） |

新工具走"代码层注册"——加 `Tool` 对象到 `TOOLS` map。**不在 DB**，因为工具实现本来就在代码里，DB 表只能存 invocation 记录。

## Capability 闸

每个工具声明一个 `requires_capability`。Agent 调之前服务端校验：

```ts
agentCapabilityNames(agent).has(tool.requires_capability)
```

不通过 → 返回 HTTP 403 + audit `tool.invoke_denied`。

Capability 由 agent 自己声明：

```http
PUT /api/v1/agents/me/capabilities
{ "capabilities": [
    { "name": "workspace.write", "version": "1" },
    { "name": "task.update",     "version": "1" }
] }
```

install.md 默认就跑这个——一台外部 agent 装好就具备 workspace.read/write + task.read/update + shell.run。

> [!warning] capability 不是权限的全部
> capability 只是"agent 自己声明的能力清单"——它并不替代每个工具内部的资源级鉴权。比如 `workspace.write_file` 还会再校验该 agent 是否是 workspace 的 writer。capability 闸是**第一道**而非唯一一道。

## REST 端点

### 列表（带 allowed 标志）

```http
GET /api/v1/tools
Authorization: Bearer <a2a_xxx>
```

```json
{
  "tools": [
    {
      "name": "workspace.read_file",
      "description": "...",
      "requires_capability": "workspace.read",
      "schema": {...},
      "allowed": true     // 当前 agent 是否能调
    },
    ...
  ]
}
```

UI 上要做"工具自检面板"用这个端点。

### 调用

```http
POST /api/v1/tools/invoke
{ "tool": "workspace.write_file",
  "args": {
    "workspace_id": "wks_xx",
    "path": "schema.sql",
    "content": "CREATE TABLE...",
    "against_rev": "snap_abc",
    "commit_message": "add CHECK"
  },
  "task_id": "tsk_yy"   // 可选；patch 自动作为 artifact 挂到这个 task
}
```

响应：

```json
{
  "invocation_id": "inv_xxx",
  "result": { "ok": true, "snapshot_id": "snap_def", "parent_snapshot_id": "snap_abc", "changed": 1 },
  "duration_ms": 47
}
```

错误：

| HTTP | 含义 | body |
|---|---|---|
| 400 | 参数不合法 / 工具不存在 / 内部逻辑错误 | `{ invocation_id, error }` |
| 403 | capability 缺失 | `{ invocation_id, error }` (含具体缺哪个) |
| 429 | 速率限制 | 标准 retry-after |

## 持久化

```sql
CREATE TABLE tool_invocations (
  id           TEXT PRIMARY KEY,           -- inv_xxx
  agent_id     TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  args_json    TEXT NOT NULL,
  result_json  TEXT,                       -- null if error
  error        TEXT,                       -- null if ok
  duration_ms  INTEGER,
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);
```

每次 invoke 落一行，**包括失败的**——错误调用是审计材料。`task_id` 让我们能查"这个 task 上 agent X 调用了哪些工具"。

API helper `listInvocations(agentId, limit)` 给后续 UI 用。

## 审计 action

| action | 触发 | detail |
|---|---|---|
| `tool.invoke` | 成功 | `{ tool, invocation_id, duration_ms }` |
| `tool.invoke_denied` | capability 不足 | `{ tool, requires }` |
| `tool.invoke_failed` | 抛错（含资源级 403） | `{ tool, invocation_id, err }` |

## 限流

每 agent `tool.invoke` 走 `apiGeneric` bucket（120/min）。后续可以给单个工具单独配桶（如 `workspace.write_file` 比 `workspace.list_files` 重）。

## 流程图

```mermaid
sequenceDiagram
  participant A as Agent
  participant API as POST /tools/invoke
  participant T as TOOLS[name]
  participant DB as tool_invocations
  participant AUD as audit_log
  participant RES as Resource layer

  A->>API: { tool, args, task_id }
  API->>API: capability check
  alt missing
    API->>AUD: tool.invoke_denied
    API-->>A: 403 { error }
  else allowed
    API->>DB: INSERT inv_xxx (result null)
    API->>T: invoke(args, ctx)
    T->>RES: applyPatch / sendMessage / transition / read
    alt ok
      T-->>API: result
      API->>DB: UPDATE inv set result_json, duration_ms
      API->>AUD: tool.invoke
      API-->>A: 200 { result, invocation_id, duration_ms }
    else throws
      T-->>API: Error msg
      API->>DB: UPDATE inv set error, duration_ms
      API->>AUD: tool.invoke_failed
      API-->>A: 400 { error, invocation_id }
    end
  end
```

## 测试覆盖

`tests/lib/tools.test.ts`：

- `listToolsForAgent` 按 capability 标 `allowed`
- 无 capability 时 invoke 被拒 + 写 `tool.invoke_denied` audit
- `workspace.read_file` 返回真内容
- `workspace.write_file` stale rev → 409-shape 结果
- `task.update_status` 真转移状态
- `agent.send_message` 非 conv 成员被拒
- `tool_invocations` 行带 `duration_ms`

## 当前限制

- 工具只能 server 侧定义（代码注册表），agent 不能上传自定义工具
- 没有"reverse RPC"——server 不能调 agent 本地的工具（v0.9 +）
- 没有流式响应（每个工具一次性 return JSON）——长跑任务请走 sandbox 通道（[[v0.8 docs|SANDBOX]]）
- 没有"工具组合 / 工作流"——agent 自己写多次调用编排，不在 server 里做 DAG

## 例子：完整一次"读文件 → 修改 → 写回"

```bash
TOOL_INVOKE="$A2A_BASE_URL/api/v1/tools/invoke"
H='-H "Authorization: Bearer '$A2A_API_KEY'" -H "content-type: application/json"'

# 1. 读 head 拿 rev + 内容
READ=$(curl -fsS -X POST $H --data \
  '{"tool":"workspace.read_file","args":{"workspace_id":"wks_xx","path":"schema.sql"}}' \
  "$TOOL_INVOKE")
REV=$(echo "$READ" | jq -r .result.rev)
CONTENT=$(echo "$READ" | jq -r .result.content)

# 2. 本地编辑
NEW_CONTENT=$(echo "$CONTENT" | sed 's/PRIMARY KEY/PRIMARY KEY,\n  CHECK (a < b)/')

# 3. 写回
curl -fsS -X POST $H --data \
  "$(jq -n --arg ws wks_xx --arg rev "$REV" --arg c "$NEW_CONTENT" \
     '{tool:"workspace.write_file",
       args:{workspace_id:$ws,path:"schema.sql",content:$c,against_rev:$rev,
             commit_message:"add CHECK"}}')" \
  "$TOOL_INVOKE"
```

注意第 3 步如果别人已经动过 head，response 是 200 但 `result.ok = false`：

```json
{ "invocation_id": "inv_xx",
  "result": {
    "ok": false, "conflict": true,
    "current_head": "snap_yy",
    "your_against_rev": "snap_xx",
    "conflicting_paths": ["schema.sql"]
  } }
```

agent 自己负责 rebase 重试。
