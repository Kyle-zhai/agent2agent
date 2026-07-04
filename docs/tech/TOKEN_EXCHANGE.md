---
title: 能力 Grant → OAuth Token Exchange（RFC 8693）
type: design
status: shipped
last_updated: 2026-07-03
tags: [grant, token-exchange, rfc8693, oauth, 委派, 跨组织, a2a]
links: [[INDEX]], [[GRANTS]], [[PROTOCOL_LANDSCAPE_2026]], [[A2A_PROTOCOL]], [[HANDOFFS]]]
---

# 能力 Grant → OAuth Token Exchange（RFC 8693）

> [!summary]
> 把已有的**签名能力 grant**从"hub 内部、只有接收方 agent 拿自己 api key 才能用"升级为
> **可被外部 agent 消费的短时、作用域收窄、可绑定受众的标准 access token**。这是
> [[PROTOCOL_LANDSCAPE_2026]] 定的头号杠杆：让 Azure Foundry / Bedrock AgentCore /
> Gemini Enterprise 的外部 agent 能**原生持有并出示**你签发的能力，而 grant 的
> **撤销/过期仍然即时生效**（比普通 OAuth 更强）。

## 为什么

`lib/grants.ts` 的 grant 是签名 DB 行，钉在 `(resource_type, resource_id)`、作用域、时限、可撤销。
但它只有 **hub 内部**可用：接收方 agent 用**自己的 api key** 调 REST 时，`agentMayUseResource`
才查它。一个**外部** agent（跑在别的云上、没有我们的 api key）**没有任何办法"持有"这个 grant**。

A2A 协议本身的鉴权是**故意做薄的**（签名卡 + securitySchemes，但凭证获取 out-of-band，
**没有委派链/作用域收窄/跨域同意**）。RFC 8693 Token Exchange 正好补这层。

## 流程

```
持有 grant 的 agent（bob）                      外部 agent（bob 委托它做事）
  │  POST /api/v1/oauth/token                        │
  │  Authorization: Bearer a2a_<bob 的 key>          │
  │  grant_type=…token-exchange                      │
  │  subject_token=<grant_id>                        │
  │  scope=read           （可选，收窄）             │
  │  audience=https://peer （可选，绑定）            │
  │───────────────────────────────►                  │
  │  ◄─ { access_token(JWT), expires_in, scope }      │
  │                                                   │
  │  ── 把 access_token 交给外部 agent ──────────────►│
  │                                                   │  GET /api/v1/workspaces/<id>
  │                                                   │  Authorization: Bearer <JWT>
  │                                                   │──────────────► hub 校验并放行
```

## Token 形态（`lib/token-exchange.ts`）

紧凑 JWS（`header.payload.sig`），claims：
- `iss` = hub origin（`NEXT_PUBLIC_APP_URL`）；`sub` = 持有 grant 的 agent（谁在行动）
- `aud` = 请求的受众（可选，绑定）；`iat/nbf/exp/jti`
- `scope` = 收窄后的作用域（空格分隔）
- `a2a` = `{ grant_id, resource_type, resource_id, from_agent_id }` —— 把 token 钉死在 grant 覆盖的那个资源

**签名算法**：
- 配了 `A2A_CARD_SIGNING_KEY` → **ES256**，外部方可用我们的公开 **JWKS**（`/.well-known/jwks.json`）验签 —— 真正的跨组织故事。
- 没配 → **HS256**（用 per-server grant 密钥）—— **hub 内可验**，开箱即用（dev/自托管）。
- header `alg` 记录用了哪个；验签**只接受这两种**，`none`/其它一律拒（alg-confusion 防御）。

## 两个比普通 OAuth 更强的性质

1. **只能收窄（attenuation-only）**：请求的 scope 必须是 grant scope 的子集；`admin` grant 覆盖任意 scope，
   但签出的 token 只带**请求的那个**（最小权限），不是 blanket admin。
2. **撤销/过期即时穿透**：`verifyAccessToken` 每次校验都**回查底层 grant**（`getGrant` + `isGrantActive`
   + 签名校验 + 持有者一致 + 资源一致 + token scope ⊆ 当前 grant scope）。所以**撤销 grant → 所有由它
   签出的 token 立刻失效**，叠加 token 自身的短 exp（默认 5min，硬顶 1h，且永不超过 grant 自身 exp）。

## 端点

- `POST /api/v1/oauth/token` —— RFC 8693 token-exchange。调用方用 `Bearer a2a_<key>` 证明自己是 grant 持有者；
  接受 `application/x-www-form-urlencoded`（OAuth 惯例）或 JSON。错误走 OAuth 形态 `{ error, error_description }`。
  限流 `apiTokenExchange`（30/min/agent），审计 `token.exchange` / `token.exchange_denied`。
- `GET /.well-known/oauth-authorization-server` —— RFC 8414 元数据，广告 token 端点 / grant type /
  subject-token type / JWKS，让外部平台**自动发现**这个能力。

## 消费（谁认这个 token）

`lib/api-auth.ts` 的 `authenticateWithCapability(req)`：
- `Bearer a2a_…` → 完整 agent（`capability: null`，走原有订阅/grant 判定）
- `Bearer <JWT>` → 校验为能力 token；acting agent = `sub`，**权限被限制到 token 的资源 + 作用域**
  （**不回落**到该 agent 自己的订阅——最小权限）。

已接入的资源端点（capability token 与 api key 双通道）：
- `GET /api/v1/workspaces/:id`（read）
- `GET /api/v1/workspaces/:id/files/*`（read）
- `POST /api/v1/workspaces/:id/patches`（write）
- `GET /api/v1/conversations/:id/messages`（read）
- `GET /api/v1/tasks/:id`（read）

> 变更类的 task/comment 端点仍**只认 api key**：能力 token 出示者无法通过它们改任务（安全默认）。

## 测试

- `tests/lib/token-exchange.test.ts`（16）：mint/verify 往返、收窄（含 admin 覆盖）、拒绝扩权、
  exp 封顶到 grant、ttl 1h 封顶、撤销即失效、token 自身过期、错 issuer、篡改 payload、
  受众绑定、alg=none 拒、ES-claimed-但没配 ES 拒、非持有者拒、ES256 往返 + 篡改签名拒。
- `tests/lib/api-auth-capability.test.ts`（5）：api-key 路径、垃圾 bearer、外部 agent 出示 token 端到端、
  撤销 grant 后 token 失活、api-key 不"借用"能力授权。

## 后续（未做，需授权）
- **DPoP / holder-of-key**（RFC 9449）真正绑定出示方密钥，而不仅 `aud`。
- **actor_token 委派链**（A→B→C 多跳），配合 append-only 审计。
- token 级撤销名单（当前靠 grant 撤销 + 短 exp；够用，但无法单独吊销一个 token）。
- 把 `scope` 语义映射到更细的资源动作（目前 read/comment/write/admin 复用 grant scope）。
