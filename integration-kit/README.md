# SCUT Integration Kit

华南理工大学校园网**可复用对接模块**（独立、零依赖本项目、可拷到任何 Node/TS 项目用）。

聚焦最通用的核心能力：**一卡通 OAuth 登录** + **水电费（dfyc）登录/查询**。域名、凭证、代理全部通过配置注入，不锁死到具体学校。

> 配套文档：
> - 校园网整体机制（VPN/CAS/教务/门户/水电费）见上级目录 `docs/campus-system.md`
> - NapCat 通用知识见 `docs/napcat-guide.md`

## 快速开始

```bash
cd integration-kit
npm install
npm run build        # 生成 dist/（CommonJS）
```

## 用法

```ts
import {
  defaultConfig,
  obtainToken,        // 一卡通登录（学号 + 查询密码）
  dfycLogin,          // 一卡通 token → dfyc JSESSIONID
  dfycQueryBills      // 查电费/水费余额
} from 'scut-integration-kit';

// 1) 配置（可覆盖域名/凭证/代理，默认是华工）
const cfg = defaultConfig({
  proxy: 'socks5://127.0.0.1:7890', // 可选，走代理时设
});

// 2) 一卡通登录（免验证码，纯自动）
const login = await obtainToken('学号', '查询密码', cfg);
// login.access_token / login.TGC / login.locSession

// 3) 走 dfyc 登录链，拿 JSESSIONID
const jsessionid = await dfycLogin(login.access_token, login.TGC, login.locSession, cfg);

// 4) 查电费/水费
const bills = await dfycQueryBills(jsessionid, cfg);
console.log(bills.electric, bills.water, bills.room);
```

## 主要 API

### auth
- `obtainToken(username, password, config?)` → 一卡通 OAuth 登录，返回 `{access_token, TGC, locSession, ...}`。**OAuth 端点不需要图形验证码**，机器人可纯自动。
- `dfycLogin(token, TGC, locSession, config?, options?)` → 走 `redirect→thirdLogin→authorize→getCode` 登录链，返回 dfyc 的 `JSESSIONID`。

### services
- `dfycQueryBills(jsessionid, config?)` → 一次查电费+水费+用户信息，返回 `{electric, water, ac, room, user}`。
- `dfycUserInfo(jsessionid, config?)` → 用户姓名/房间/楼栋/校区。
- `dfycElectricBalance(jsessionid, config?)` / `dfycWaterBalance(jsessionid, config?)` → 单独查电费/水费。

### http / config
- `createFetch(proxy?)` → 带代理 + 手动重定向能力的 fetch。
- `extractCookie(setCookieHeader, name)` → 从 Set-Cookie 提取指定 cookie。
- `defaultConfig(overrides?)` → 生成配置（含默认域名/凭证）。

## 配置项（`ScutConfig`）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `cardBase` | `https://ecardwxnew.scut.edu.cn` | 一卡通 OAuth 主站 |
| `dfycBase` | `https://dfyc.utc.scut.edu.cn` | 水电费业务系统 |
| `ssoBase` | `https://sso.scut.edu.cn` | 统一认证中心 |
| `oauthClientBasic` | 华工一对凭证的 Base64 | OAuth Basic 客户端凭证 |
| `dfycAppId` | `360` | 水电费跳转的 appId |
| `dfycLoginSuccessPath` | `/sdms-weixin-pay-sp/newWeixin/index.html` | 登录成功跳转校验路径 |
| `proxy` | `''` | 代理地址，如 `socks5://127.0.0.1:7890`，空=直连 |

## 说明 / 注意

- **登录方式差异**：`-sp` 版用一卡通 OAuth（`obtainToken`，免验证码）；无 `-sp` 版走统一 CAS（需验证码/扫码）。本模块封装的是 **-sp 版**（可自动化）。详见 `docs/campus-system.md` 第 8 节。
- **会话有效期**：`JSESSIONID` / `access_token` 都是服务端 Session，短期有效。做长期运行的程序要「过期自动重新登录」兜底。
- **涉及真实金钱**：充值接口（`zhixiaopay/save`）不在本模块自动调用范围，充值必须人工确认。
- **网络**：本机走代理才能在公网访问校内系统时，把 `proxy` 指到你本地的 http/socks 端口。

## 独立复用

本目录**自包含**（有自己的 `package.json`，只依赖 `undici`/`fetch-socks` + Node 内置，不 import 上级项目任何模块）。要用于其它项目，直接拷贝 `integration-kit/` 整个目录（或只拷 `src/` + 配好自己的构建），`npm install` 后即可用。

预留扩展方向：`auth/cas.ts`（统一 CAS 登录）、`services/jwxt.ts`（教务课表/成绩）、`services/portal.ts`（门户分区）——接口形态与现有模块一致，按需增加即可。
