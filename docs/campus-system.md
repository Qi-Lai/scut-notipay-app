# 华南理工校园网系统对接说明

> **本文档是关于学校校园网/一卡通系统的对接知识，不是 NapCat 本体的内容。**
> NapCat 通用参考见 [NapCat 开发技术参考](napcat-guide.md)。
>
> 适合：在 scut-notipay 这类学校信息化项目里，接入宿舍电费/水费查询、充值、校园认证时使用。

---

## 目录

- [1. 涉及的域名](#1-涉及的域名)
- [2. 校园认证链路（SSO）](#2-校园认证链路sso)
- [3. 登录态与 JSESSIONID](#3-登录态与-jsessionid)
- [4. 两套后端入口：`-sp` vs 无 `-sp`](#4-两套后端入口-sp-vs-无-sp)
- [5. 常见接口](#5-常见接口)
- [6. 对接注意事项](#6-对接注意事项)

---

## 1. 涉及的域名

| 域名 | 作用 |
|------|------|
| `ecardwxnew.scut.edu.cn` | 校园一卡通 **OAuth 主站**（登录/授权） |
| `dfyc.utc.scut.edu.cn` | 宿舍水电费**业务系统**（查询/充值/用户信息） |

> 核心：登录在一卡通主站（`ecardwxnew`），业务数据在 `dfyc`。两者通过 SSO 跳转建立会话关联。

---

## 2. 校园认证链路（SSO）

接入 `dfyc` 业务系统前，必须先从一卡通主站拿 `access_token`，再通过一串 302 跳转在 `dfyc` 建立会话：

```
1. 登录一卡通主站 → 拿 access_token（OAuth bearer）
2. 访问 ecardwxnew 的 /berserker-base/redirect?appId=360&...synjones-auth=<token>
3. 302 → thirdLogin → authorize → getCode（dfyc /.../service/ykt/getCode）
4. 最终在 dfyc 建立 JSESSIONID 会话
```

### 关键区别（容易踩坑）

- 一卡通主站的 **`access_token`** ≠ 业务系统 `dfyc` 的 **`JSESSIONID`**。
- `dfyc` 要的是**走完这串 302 后建立的 `JSESSIONID`**，不是一开始那个 `access_token`。
- 每次查询都可能需要重走这串 302（除非会话未过期）。客户端不持有这个 JSESSIONID 的时候，必须现场构建。

---

## 3. 登录态与 JSESSIONID

- `dfyc` 的登录态是**服务端 Session**，客户端靠 **`JSESSIONID` Cookie** 维持。
- **Session 时长由服务端配置**（常见 30 分钟不活跃失效），客户端无法决定。
- 接口调用靠 Cookie 自动携带（HttpOnly），**不需要在前端管理 token**。
- 一旦 Session 过期，接口返回 401 / 302 跳转登录。

---

## 4. 两套后端入口：`-sp` vs 无 `-sp`

同一个业务系统有两个入口路径，**实测确认是两套不同的后端**：

| 入口 | 登录跳转 | 结论 |
|------|---------|------|
| `sdms-weixin-pay`（无 `-sp`） | 302 → dfyc 内部 `weixin/thirdLogin` | **老版后端**，数据/电表下发慢、可能丢单 |
| `sdms-weixin-pay-sp`（有 `-sp`） | 302 → 一卡通 OAuth SSO | **新版后端**，走统一 SSO，快且稳 |

### 重要结论

**对接时应优先用 `-sp` 版接口。** 实测：无 `-sp` 版会导致「到账慢、信息更新慢、甚至一次没到账」；`-sp` 版无此问题。

> 判断方法：不带会话去请求 `/service/find/userinfo`，看它 302 到哪——`-sp` 版跳一卡通主站 OAuth，无 `-sp` 版跳 dfyc 内部 thirdLogin。

---

## 5. 常见接口

以下接口都基于 `dfyc.utc.scut.edu.cn`，需携带 `JSESSIONID` Cookie：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/sdms-weixin-pay-sp/service/find/userinfo` | GET | 用户信息（realName / roomName / 楼栋等） |
| `/sdms-weixin-pay-sp/service/ammeterBalance?type=1` | GET | 电表余额（leftEle / leftMoney / elePrice） |
| `/sdms-weixin-pay-sp/service/waterBalance?type=3&systemType=1` | GET | 水费余额 |
| `/sdms-weixin-pay-sp/service/zhixiaopay/save` | POST | 生成充值单（body `{payType,payMoney,payQuantity}`，返回微信支付 URL） |

> **注意**：`save` 是发起充值的接口，返回的是**微信支付跳转 URL**。支付必须由用户确认完成（扫码/点击），程序不能也无法替用户完成真实支付。**涉及真实金钱，务必保留人工确认环节。**

---

## 6. 对接注意事项

1. **认准 `-sp` 版**：查询、充值都用 `-sp` 路径，避免老版后端的数据下发慢/丢单问题。
2. **会话复用**：`JSESSIONID` 是短期有效的。写代码时要能「会话过期自动重新走一遍 SSO 登录」兜底。
3. **充值必须人工支付**：`save` 只生成支付单，支付环节留给用户；不要自动化真实扣款。
4. **查询（只读）安全**：查询余额、提醒是只读操作，风险低，可长期稳定运行。
5. **不要只凭 `access_token` 就认为能调业务接口**——`dfyc` 认的是它的 `JSESSIONID`，需要走完 SSO 跳转。
