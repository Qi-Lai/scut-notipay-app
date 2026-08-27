# 华南理工大学校园网对接参考

> **本文档是关于学校校园网/统一认证的对接知识，不是 NapCat 本体的内容。**
> NapCat 通用参考见 [NapCat 开发技术参考](napcat-guide.md)。
>
> 适合：接入华南理工校园网相关服务（统一认证、门户、宿舍水电费等）时使用。
> 内容基于实际抓包 / 配置文件分析 / 只读探测整理，**含敏感细节（认证流程、字段结构），注意控制分发范围。**

---

## 目录

- [1. 校园网整体架构](#1-校园网整体架构)
- [2. 校外接入：VPN（EasyConnect）与统一认证的关系](#2-校外接入vpneasyconnect与统一认证的关系)
- [3. 统一身份认证（CAS / SSO）](#3-统一身份认证cas--sso)
- [4. 门户 my.scut.edu.cn](#4-门户-myscuteducn)
- [5. 教务系统（jwglxt / 正方）](#5-教务系统jwglxt--正方)
- [6. 宿舍水电费系统（dfyc）](#6-宿舍水电费系统dfyc)
- [7. 登录态与-JSESSIONID](#7-登录态与-jsessionid)
- [8. 两套后端入口：`-sp` vs 无 `-sp`](#8-两套后端入口-sp-vs-无-sp)
- [9. 对接注意事项](#9-对接注意事项)

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

## 2. 校外接入：VPN（EasyConnect）与统一认证的关系

校外（非校园网环境）访问校内系统，需先经过 **SSL VPN 接入**。这是「网络可达性」层，与「统一 CAS 认证」层是**两件串行的事**，各管一段。

### 2.1 接入点与客户端

- **VPN 地址**：`https://sslvpn2.scut.edu.cn`
- **客户端**：深信服 **EasyConnect**（`ssl`+`vpn` 域名、登录门户 `por/login_psw.csp`、客户端探测脚本等特征可确认是 EasyConnect）
- **定位**：让校外设备在逻辑上「回到」校园网，从而能访问到校内地址（`my.scut.edu.cn`、`jw2018.jw.scut.edu.cn` 等）。

### 2.2 双层模型（实测确认）

```
校外环境
  │
  ▼
① VPN 接入（EasyConnect）            ← 管「网络可达性」
  │  账号 + 密码 + 3分钟 SSLVPN 专用验证码 → 建立加密隧道
  ▼
② 访问校内系统（门户/教务）            ← 到达后系统检测未登录 → 跳统一认证
  │
  ▼
③ 统一身份认证（CAS）                ← 管「身份授权」
  │  账号 + 密码 + 90秒 验证码 → CASTGC → ticket → 进入系统
  ▼
④ 访问具体功能（门户首页、成绩、课表…）
```

> **关键事实（实测）**：VPN 连接成功后，访问移动门户等校内网站**仍会再走一次统一认证**。因为 VPN 只解决「能不能连到」（网络层），不解决「是否已验证身份」（应用层）。校内系统总会在未登录会话时跳回 `sso.scut.edu.cn/cas/login`。

### 2.3 VPN 与统一认证的关系（账号同源、服务独立）

| 对比项 | 统一认证（CAS / sso.scut.edu.cn） | SSL VPN（sslvpn2.scut.edu.cn） |
|--------|----------------------------------|-------------------------------|
| 账号 | 学号（校统一身份库） | 学号（**同一个**） |
| 密码 | 同一套 | 同一套 |
| 验证码 | **90 秒**（短时效） | **3 分钟、标注 (SSLVPN)** |
| 发送渠道 | 学校微信服务号 | **同**一个微信服务号 |
| 认证端点(CAS) | 是（标准 ticket 流程） | **否**（EasyConnect 门户自己的登录逻辑） |

**结论**：账号密码和验证码渠道**同源**（共用校统一身份库 + 同一个微信服务号），但**认证服务是两套独立端点**——CAS 走 ticket，VPN 走 EasyConnect 门户。**「账号密码一样」≠「走同一个 CAS」**。

### 2.4 对项目对接的意义

- **工具只需处理「应用层 CAS 登录」**（访问门户/教务时主动登录），这是已探明并成型的核心。
- **VPN 层不建议自动化**：VPN 登录用自己的账号体系 + 3分钟专用验证码，时效短、涉及 VPN 账号，且是用户网络环境的事。应作为文档提示（「请先连接校园网或学校 SSL VPN」），由用户自行处理网络可达性。

---

## 3. 统一身份认证（CAS / SSO）

### 3.1 认证中心

- **域名**：`sso.scut.edu.cn`
- **登录页**：`https://sso.scut.edu.cn/cas/login?service=<回调地址>`
- **类型**：Apereo CAS（5.x，从 `execution` 字段判断）

### 3.2 CAS 登录流程

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

### 3.3 表单字段（实测确认）

- `<form id="loginForm" action="/cas/login?service=..." method="post">`
- 隐藏字段：`lt`（形如 `LT-2715050-xxx-cas`）、`execution`（形如 `e1s1`）、`_eventId=submit`
- 页面含 `captcha` / `slide` 验证 —— **对接时需处理验证码/滑块**（这是主要难点）

### 3.4 关键参数

| 参数 | 说明 |
|------|------|
| `service` | 登录成功后跳回的应用地址，CAS 用它对应用白名单校验 |
| `ticket` | 认证通过后的 CAS 票据（`ST-xxx`），业务系统用它换用户信息 |
| `lt` / `execution` | 每次 GET 登录页动态生成，POST 必须回传 |

---

## 4. 门户 my.scut.edu.cn

- **入口**：`https://my.scut.edu.cn` → 301 到 `/up` → 302 到 `/up/`
- **登录保护**：未登录访问会 302 到 `sso.scut.edu.cn/cas/login?service=<up/...>`
- **定位**：校内统一门户，聚合多种服务。登录后可按需探索其 API（成绩、课表、消息等）。

---

## 5. 教务系统（jwglxt / 正方）

教务是校园网最重要的功能系统之一，采用**正方教务系统（ZFSoft / 教学管理信息服务平台）**框架（`jwglxt` 前缀、`zftal-ui` 静态资源、`login_slogin.html` 等特征可确认）。

### 5.1 入口与认证

- **入口域名**：`https://jw2018.jw.scut.edu.cn`
- **CAS service**：`http://jw2018.jw.scut.edu.cn/sso/driotlogin`
  - 访问 `jw2018.jw.scut.edu.cn` → JS 跳到 `sso.scut.edu.cn/cas/login?service=<上值>`
  - 拿到 `ticket` 后访问 `?ticket=ST-xxx` → 服务端校验 → 进入教务

### 5.2 SSO 流转到教务（关键链路，实测确认）

登录一次拿到 `CASTGC` 后，访问教务 service 会自动发 ticket，最终在教务系统落地：

```
GET https://sso.scut.edu.cn/cas/login?service=<教务service>   （带 CASTGC）
  → 302 + ticket=ST-xxx
GET http://jw2018.jw.scut.edu.cn/sso/driotlogin?ticket=ST-xxx
  → 302
GET /jwglxt/ticketlogin?uid=<学号>&timestamp=<秒级时间戳>&verify=<签名>
  → 进入教务后台（发放教务 JSESSIONID）
```

- **`ticketlogin`** 是教务教务系统的登录凭证接口：`uid`（学号）+ `timestamp`（秒级）+ `verify`（服务端签名，HMAC/MD5）。`verify` 由服务端依据 uid+timestamp+密钥计算，客户端无法伪造。
- 进入后教务系统在 `jw2018.jw.scut.edu.cn` 域种下 **`JSESSIONID`**（HttpOnly）+ `clwz_blc_pst_JWC_xxx`（persistence，负载均衡粘滞）。

### 5.3 核心数据接口（实测确认，均在 `jw2018.jw.scut.edu.cn/jwglxt` 下）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/jwglxt/xtgl/index_initMenu.html?jsdm=xs` | GET | 登录后学生首页菜单/数据（`jsdm=xs` 学生代码） |
| `/jwglxt/kbcx/xskbcx_cxXsKb.html?xnm=<学年>&xqm=<学期>` | GET | **课表查询**（`xnm` 学年如 2025，`xqm` 学期如 3），返回课程/班级/教师 JSON |
| `/jwglxt/cjcx/cjcx_cxXsKcjg.html?xnm=<学年>&xqm=<学期>` | GET | **成绩查询**，返回分页 JSON（`queryModel`/`totalResult`/成绩记录） |

> 请求示例（在已登录会话内）：`/jwglxt/kbcx/xskbcx_cxXsKb.html?xnm=2025&xqm=3` → 返回含 `XH`/`XM`/`BJMC`/`XNMC`/`KCMS` 等字段的学生课表 JSON。
> `xnm` = 学年（如 2025 表示 2025-2026 学年），`xqm` = 学期（1/2/3 对应秋/春/夏等，实际以返回为准）。每次请求需带教务 `JSESSIONID` cookie。

### 5.4 对接要点

- 课表/成绩接口需 **`X-Requested-With: XMLHttpRequest`** 头，并带教务 `JSESSIONID` cookie。
- `xnm`/`xqm` 需先获取当前学年学期（可从 `index_initMenu` 返回或课表返回的 `XNMC`/`XQM` 推断）。
- 教务会话（JSESSIONID）是服务端 Session，**短期有效**，需做「过期自动重新走 SSO」兜底。

---

## 6. 宿舍水电费系统（dfyc）

宿舍水电费是校园网的一个业务子系统，有两套后端入口（见第 8 节）：

| 域名 | 作用 |
|------|------|
| `ecardwxnew.scut.edu.cn` | 一卡通 **OAuth 主站**（某些情况下作为登录前置） |
| `dfyc.utc.scut.edu.cn` | 宿舍水电费**业务系统**（用户信息 / 电表 / 水费 / 充值） |

### 常见接口（基于 `dfyc.utc.scut.edu.cn`）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/sdms-weixin-pay/service/find/userinfo` | GET | 用户信息（realName / roomName / 楼栋） |
| `/sdms-weixin-pay/service/ammeterBalance?type=1` | GET | 电表余额（leftEle / leftMoney / elePrice） |
| `/sdms-weixin-pay/service/waterBalance?type=3&systemType=1` | GET | 水费余额 |
| `/sdms-weixin-pay/service/zhixiaopay/save` | POST | 生成充值单（body `{payType,payMoney,payQuantity}`，返回微信支付 URL） |

---

## 7. 登录态与 JSESSIONID

业务系统（如 dfyc）的登录态是**服务端 Session**，客户端靠 **`JSESSIONID` Cookie** 维持。

- **Session 时长是服务端配置的**（常见 30 分钟不活跃失效），客户端无法决定。
- 接口调用靠 Cookie 自动携带（HttpOnly），不需要前端管理 token。
- 一旦 Session 过期，接口返回 401 / 302 跳登录。
- **重要区别**：CAS 登录后的 `ticket` / 主站的 `access_token`，**不等于**业务系统的 `JSESSIONID`。业务系统通常需要走它自己的授权跳转（经 `ecardwxnew` 或 `getCode` 等）才能真正建立 `JSESSIONID`。

---

## 8. 两套后端入口：`-sp` vs 无 `-sp`

同一个水电费业务系统有两个入口，**实测确认是两套不同后端**：

| 入口 | 登录跳转 | 结论 |
|------|---------|------|
| `sdms-weixin-pay-sp`（有 `-sp`） | 302 → 一卡通/SSO | **信息落后版**，数据下发/更新慢，可能丢单，**应弃用** |
| `sdms-weixin-pay`（无 `-sp`） | 302 → dfyc 内部 `weixin/thirdLogin` | **应使用版**，数据及时、新、到账快 |

> ⚠️ **更正**：此前文档误将 `-sp` 版当作新版/优先版。实际以使用验证为准 —— **带 `-sp` 的版本信息落后（数据更新慢、可能丢单），应弃用；应使用无 `-sp` 版接口。**

**对接时应使用无 `-sp` 版接口**（`/sdms-weixin-pay/service/...`）。

> 判断方法：不带会话去请求 `/service/find/userinfo`，看它 302 到哪 —— 无 `-sp` 版跳 dfyc 内部 `thirdLogin`，`-sp` 版跳统一认证/SSO。

---

## 9. 对接注意事项

1. **先掌握统一认证（CAS）**：不管接哪个业务，多半要先过 `sso.scut.edu.cn` 的 CAS 登录。`lt` / `execution` 动态生成、页面有滑块验证码，是主要门槛。
2. **认准 `-sp` 版**：查询、充值都用 `-sp` 路径，避免老版后端的数据下发慢/丢单。
3. **会话复用与重建**：`JSESSIONID` / `ticket` 都是短期有效。写代码要做「会话过期自动重新走一遍登录」的兜底。
4. **充值必须人工支付**：`save` 只生成支付单，支付环节交给用户（微信扫码），**不要自动化真实扣款**。
5. **只读查询安全**：查余额、提醒等只读操作风险低，可长期稳定运行。
6. **认证 ≠ 业务会话**：拿到 CAS `ticket` 或主站 `access_token` 不代表能直接调业务接口，业务系统往往还要再走它自己的一层授权才建立 `JSESSIONID`。

---

> 探测基于公开 URL + 只读 HTTP 探测，未提交任何账号密码或真实数据。若要实际对接，请遵守学校网络使用规范，勿用于自动化真实付费操作。
