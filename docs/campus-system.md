# 华南理工大学校园网对接参考

> **本文档是关于学校校园网/统一认证的对接知识，不是 NapCat 本体的内容。**
> NapCat 通用参考见 [NapCat 开发技术参考](napcat-guide.md)。
>
> 适合：接入华南理工校园网相关服务（统一认证、门户、宿舍水电费等）时使用。
> 内容基于实际抓包 / 配置文件分析 / 只读探测整理，**含敏感细节（认证流程、字段结构），注意控制分发范围。**

---

## 目录

- [1. 校园网整体架构](#1-校园网整体架构)
- [2. 统一身份认证（CAS / SSO）](#2-统一身份认证cas--sso)
- [3. 门户 my.scut.edu.cn](#3-门户-myscuteducn)
- [4. 宿舍水电费系统（dfyc）](#4-宿舍水电费系统dfyc)
- [5. 登录态与-JSESSIONID](#5-登录态与-jsessionid)
- [6. 两套后端入口：`-sp` vs 无 `-sp`](#6-两套后端入口-sp-vs-无-sp)
- [7. 对接注意事项](#7-对接注意事项)

---

## 1. 校园网整体架构

校园网采用**统一身份认证（CAS）**作为全校登录中心，各个业务系统都是它的**下游应用**：

```
                        ┌─────────────────────┐
   my.scut.edu.cn       │  sso.scut.edu.cn    │
   （统一门户 /up） ──→  │  CAS 认证中心        │
                        │  /cas/login         │
                        └─────────┬───────────┘
              ┌─────────────┬─────┴──────┬──────────────┐
              ▼             ▼            ▼              ▼
        dfyc（水电费）   （教务）      （图书馆）     …其他业务
            ^
            │（走 CAS 授权后建立会话）
```

**核心结论**：全校登录走 **`sso.scut.edu.cn` 的 Apereo CAS**。任何业务系统对接，基本都可归纳为「CAS 登录拿凭据 → 业务系统建立会话」。

---

## 2. 统一身份认证（CAS / SSO）

### 2.1 认证中心

- **域名**：`sso.scut.edu.cn`
- **登录页**：`https://sso.scut.edu.cn/cas/login?service=<回调地址>`
- **类型**：Apereo CAS（5.x，从 `execution` 字段判断）

### 2.2 CAS 登录流程

1. 访问业务系统（如 `my.scut.edu.cn/up/?service=...`）→ 302 跳转到 `sso.scut.edu.cn/cas/login?service=...`
2. **GET** 登录页 → 解析出动态隐藏字段：`lt`（Login Ticket）+ `execution`
3. **POST** 回登录页，携带：
   ```
   username=学号
   password=密码
   lt=<上一步拿到的 LT-xxx>
   execution=<上一步 execution 值>
   _eventId=submit
   ```
4. 认证成功后，CAS 302 回 `service` 参数指定的 URL，并**附带 `ticket`**（`/up/?service=...&ticket=ST-xxx`）
5. 业务系统拿 `ticket` 去 CAS **校验**（`/cas/serviceValidate?ticket=...&service=...`），换回用户名等属性 → 建立业务会话

### 2.3 表单字段（实测确认）

- `<form id="loginForm" action="/cas/login?service=..." method="post">`
- 隐藏字段：`lt`（形如 `LT-2715050-xxx-cas`）、`execution`（形如 `e1s1`）、`_eventId=submit`
- 页面含 `captcha` / `slide` 验证 —— **对接时需处理验证码/滑块**（这是主要难点）

### 2.4 关键参数

| 参数 | 说明 |
|------|------|
| `service` | 登录成功后跳回的应用地址，CAS 用它对应用白名单校验 |
| `ticket` | 认证通过后的 CAS 票据（`ST-xxx`），业务系统用它换用户信息 |
| `lt` / `execution` | 每次 GET 登录页动态生成，POST 必须回传 |

---

## 3. 门户 my.scut.edu.cn

- **入口**：`https://my.scut.edu.cn` → 301 到 `/up` → 302 到 `/up/`
- **登录保护**：未登录访问会 302 到 `sso.scut.edu.cn/cas/login?service=<up/...>`
- **定位**：校内统一门户，聚合多种服务。登录后可按需探索其 API（成绩、课表、消息等）。

---

## 4. 宿舍水电费系统（dfyc）

宿舍水电费是校园网的一个业务子系统，有两套后端入口（见第 6 节）：

| 域名 | 作用 |
|------|------|
| `ecardwxnew.scut.edu.cn` | 一卡通 **OAuth 主站**（某些情况下作为登录前置） |
| `dfyc.utc.scut.edu.cn` | 宿舍水电费**业务系统**（用户信息 / 电表 / 水费 / 充值） |

### 常见接口（基于 `dfyc.utc.scut.edu.cn`）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/sdms-weixin-pay-sp/service/find/userinfo` | GET | 用户信息（realName / roomName / 楼栋） |
| `/sdms-weixin-pay-sp/service/ammeterBalance?type=1` | GET | 电表余额（leftEle / leftMoney / elePrice） |
| `/sdms-weixin-pay-sp/service/waterBalance?type=3&systemType=1` | GET | 水费余额 |
| `/sdms-weixin-pay-sp/service/zhixiaopay/save` | POST | 生成充值单（body `{payType,payMoney,payQuantity}`，返回微信支付 URL） |

---

## 5. 登录态与 JSESSIONID

业务系统（如 dfyc）的登录态是**服务端 Session**，客户端靠 **`JSESSIONID` Cookie** 维持。

- **Session 时长是服务端配置的**（常见 30 分钟不活跃失效），客户端无法决定。
- 接口调用靠 Cookie 自动携带（HttpOnly），不需要前端管理 token。
- 一旦 Session 过期，接口返回 401 / 302 跳登录。
- **重要区别**：CAS 登录后的 `ticket` / 主站的 `access_token`，**不等于**业务系统的 `JSESSIONID`。业务系统通常需要走它自己的授权跳转（经 `ecardwxnew` 或 `getCode` 等）才能真正建立 `JSESSIONID`。

---

## 6. 两套后端入口：`-sp` vs 无 `-sp`

同一个水电费业务系统有两个入口，**实测确认是两套不同后端**：

| 入口 | 登录跳转 | 结论 |
|------|---------|------|
| `sdms-weixin-pay`（无 `-sp`） | 302 → dfyc 内部 `weixin/thirdLogin` | **老版后端**，数据/电表下发慢、可能丢单 |
| `sdms-weixin-pay-sp`（有 `-sp`） | 302 → 一卡通/SSO | **新版后端**，走统一 SSO，快且稳 |

**对接时应优先用 `-sp` 版接口。** 实测：无 `-sp` 版会导致「到账慢、信息更新慢、甚至没到账」。

> 判断方法：不带会话去请求 `/service/find/userinfo`，看它 302 到哪 —— `-sp` 版跳统一认证/SSO，无 `-sp` 版跳 dfyc 内部 thirdLogin。

---

## 7. 对接注意事项

1. **先掌握统一认证（CAS）**：不管接哪个业务，多半要先过 `sso.scut.edu.cn` 的 CAS 登录。`lt` / `execution` 动态生成、页面有滑块验证码，是主要门槛。
2. **认准 `-sp` 版**：查询、充值都用 `-sp` 路径，避免老版后端的数据下发慢/丢单。
3. **会话复用与重建**：`JSESSIONID` / `ticket` 都是短期有效。写代码要做「会话过期自动重新走一遍登录」的兜底。
4. **充值必须人工支付**：`save` 只生成支付单，支付环节交给用户（微信扫码），**不要自动化真实扣款**。
5. **只读查询安全**：查余额、提醒等只读操作风险低，可长期稳定运行。
6. **认证 ≠ 业务会话**：拿到 CAS `ticket` 或主站 `access_token` 不代表能直接调业务接口，业务系统往往还要再走它自己的一层授权才建立 `JSESSIONID`。

---

> 探测基于公开 URL + 只读 HTTP 探测，未提交任何账号密码或真实数据。若要实际对接，请遵守学校网络使用规范，勿用于自动化真实付费操作。
