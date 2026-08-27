# NapCat 开发技术参考（OneBot11）

> 本文档基于 scut-notipay-app 项目对 NapCat 的实测与排查整理，面向**后续所有需要对接 NapCat 的项目**。涵盖 NapCat 的架构、安装、OneBot11 配置、登录认证、启动方式与常见坑。所有结论均来自实际抓包 / 配置文件分析 / 实机验证，而非猜测。

---

## 目录

- [1. NapCat 是什么](#1-napcat-是什么)
- [2. 架构与目录结构](#2-架构与目录结构)
- [3. OneBot11 配置详解](#3-onebot11-配置详解)
- [4. 登录认证机制](#4-登录认证机制)
- [5. 启动方式（Windows）](#5-启动方式windows)
- [6. 常见坑与排查](#6-常见坑与排查)
- [7. 一键管理实现思路（本项目案例）](#7-一键管理实现思路本项目案例)

---

## 1. NapCat 是什么

NapCat 是一个 **QQ 机器人协议端**（OneBot 11 实现），它让你能用标准 OneBot 协议连接 QQ，收发消息、处理群/私聊事件。它基于 QQNT（QQ 新版客户端）的内部机制，通过**注入 QQ 进程的 hook** 来接管消息收发。

- **定位**：介于「QQ 客户端」和你「机器人后端」之间的协议转换层。
- **协议**：OneBot 11（`send_private_msg` / `send_group_msg` / 事件回调等）。
- **连接方式**：正反向 WebSocket（`ws://`）、HTTP、WebSocket 客户端。本项目用**正向 WebSocket Server**。
- **上游**：[NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)。

> 通俗理解：NapCat 把「QQ 客户端」变成一个能收发消息、监听事件的**协议服务**，你的机器人代码只需连上它的 WebSocket 端口即可。

---

## 2. 架构与目录结构

NapCat 的 Windows 部署（OneKey 一键包）典型结构：

```
NapCat.Shell.Windows.OneKey/          # 一键包根目录
├── NapCat.Shell/                     # NapCat 框架主目录（核心）
│   ├── napcat.mjs                    # 框架入口（Node ESM）
│   ├── qqnt.json                     # 框架期望的 QQ 版本描述
│   ├── loadNapCat.js                 # 启动桩：import napcat.mjs（由启动器生成）
│   ├── NapCatWinBootMain.exe         # 启动器（注入 QQ + 拉起框架）
│   ├── NapCatWinBootHook.dll         # 注入到 QQ 进程的 Hook DLL
│   ├── config/
│   │   ├── napcat.json               # 框架级配置（日志、bypass 等）
│   │   ├── webui.json                # WebUI 配置（端口/token）
│   │   └── onebot11_<uin>.json       # OneBot11 配置（按 QQ 账号分文件）
│   └── cache/
│       └── qrcode.png                # 登录二维码（扫码用）
├── NapCat.44498.Shell/               # NapCat 自带的「版本匹配 QQ」实例
│   ├── QQ.exe                        # 自带 QQ 启动器
│   ├── NapCatWinBootMain.exe
│   ├── NapCatWinBootHook.dll
│   └── versions/9.9.26-44498/        # 该 QQ 版本的运行库
└── bootmain/                        # 另一种更简化的启动器（可选）
```

### 关键：为什么有「框架」和「自带 QQ」两套

- **`NapCat.Shell/`** = 框架（`napcat.mjs` + 注入 DLL），**不带 QQ**。
- **`NapCat.44498.Shell/`** = NapCat 自带的**版本匹配的 QQ 实例**（有自己的 `QQ.exe` + `versions/`）。

**NapCat 的注入 Hook 是针对特定 QQ 版本编译的**。如果要注入它自带的 QQ（`NapCat.44498.Shell\QQ.exe`），hook 与 QQ 版本匹配，能正常工作；**如果去注入系统里自行升级的新版 QQ，hook 版本不匹配会导致注入失败 → QQ 报「文件已损坏」**。这是本项目排查中最重要的结论之一。

---

## 3. OneBot11 配置详解

OneBot11 配置存放在 `config/onebot11_<uin>.json`（按 QQ 账号 uin 分文件），**首次扫码登录成功后才会生成**。

### 3.1 正向 WebSocket Server 字段

```
network.websocketServers[].{
  name                 // 标识名，如 "websocket-server"
  enable               // 是否启用（默认 false）
  host                 // 绑定地址，默认 127.0.0.1
  port                 // 端口，默认 3001
  messagePostFormat    // "array" | "string"
  reportSelfMessage    // 是否上报自身消息
  token                // 访问令牌，空则不校验
  enableForcePushEvent
  debug
  heartInterval        // 心跳间隔 ms
}
```

> `enable` 默认是 `false` —— **NapCat 默认不开启任何端口**，必须手动在配置里写入并置 `true` 才会真正监听。这是「为什么点了一键启动却没端口」的根源之一。

### 3.2 配置文件生成时机

- 必须先用一个 QQ 账号**扫码登录成功**，NapCat 才会生成 `onebot11_<uin>.json`。
- 登录前 `config/` 里只有 `napcat.json` 和 `webui.json`。

### 3.3 注入口诀：保守手术（conservative surgery）

不假定 NapCat 的完整字段集合（版本会变）。**建议只翻转目标 WS 条的 `enable`/`host`/`port`/`token`，其余字段（包括未来新增的）原样保留**。找不到则新增一条。这样 NapCat 升级也不会写坏配置。

---

## 4. 登录认证机制

### 4.1 登录态 = 服务端 Session + JSESSIONID Cookie

NapCat 所在的校园/应用系统（如 dfyc）的登录态是**服务端 Session**，客户端靠 **`JSESSIONID` Cookie** 维持。**这不是客户端能决定的**，时长由服务端配置（常见 30 分钟不活跃即失效）。

- 接口调用靠浏览器/客户端**自动携带的 Cookie**，不需要前端管理 token。
- 一旦 Session 过期，接口返回 401/302 跳登录。

### 4.2 认证链路（一卡通 / 校园 SSO）

本项目接入的校园系统典型认证链路（`ecardwxnew` 主站 → `dfyc` 业务系统）：

```
1. 拿 access_token（OAuth bearer）
2. 访问 ecardwxnew 的 /berserker-base/redirect?appId=360&...synjones-auth=<token>
3. 302 → thirdLogin → authorize → getCode（.../service/ykt/getCode）
4. 最终在 dfyc 建立 JSESSIONID 会话
```

> **关键区别**：一卡通主站的 `access_token` ≠ 业务系统的 `JSESSIONID`。业务系统要的是**走完这串 302 后建立的 JSESSIONID**。每次查询都可能需要重新走一遍（除非会话未过期）。

### 4.3 无 -sp 版 vs 有 -sp 版（重要）

同一个系统可能有两个入口路径（本项目实测确认是**两套不同后端**）：

| 入口 | 登录跳转 | 结论 |
|------|---------|------|
| `sdms-weixin-pay`（无 `-sp`） | 302 → dfyc 内部 `weixin/thirdLogin` | **老版后端**，数据/电表下发慢、可能丢单 |
| `sdms-weixin-pay-sp`（有 `-sp`） | 302 → 一卡通 OAuth SSO | **新版后端**，走统一 SSO，快且稳 |

**对接时应优先用 `-sp` 版**；老版会导致「到账慢 / 信息更新慢 / 没到账」。

---

## 5. 启动方式（Windows）

### 5.1 官方 launcher.bat（要求管理员权限）

```
@echo off
net session >nul 2>&1          # 检查是否管理员
if %ERRORLEVEL% == 0 (
    goto :run
) else (
    powershell -Command "Start-Process '%~f0' -Verb runAs"   # 弹 UAC 提权重启
    exit /b
)
:run
set NAPCAT_PATCH_PACKAGE=<shell>\qqnt.json
set NAPCAT_LOAD_PATH=<shell>\loadNapCat.js
set NAPCAT_INJECT_PATH=<shell>\NapCatWinBootHook.dll
set NAPCAT_LAUNCHER_PATH=<shell>\NapCatWinBootMain.exe
set NAPCAT_MAIN_PATH=<shell>\napcat.mjs
echo (async () => { await import("file:///%NAPCAT_MAIN_PATH%") })() > loadNapCat.js
"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%" %*
```

### 5.2 两个核心坑

1. **必须管理员权限（UAC 提权）**：普通权限启动能拉起 QQ（带 `--enable-logging`），但**框架 hook 无法完成注入加载** → 端口不开、日志不生成、看不到扫码窗。
2. **注入目标 QQ 要选对**：用**系统升过级的 QQ** 会报「文件已损坏」；用 **NapCat 自带版本匹配的 QQ**（`NapCat.44498.Shell\QQ.exe`）才正常。

### 5.3 启动成功的标志

- QQ 进程命令行带 **`--enable-logging`**（NapCat 注入标记）。
- WebUI 端口（默认 6099）监听（框架在跑）。
- **正向 WS 端口（如 3001）监听** = 配置已生效、可被机器人连接。

---

## 6. 常见坑与排查

| 现象 | 根因 | 解决 |
|------|------|------|
| 点「一键启动」无反应 | 状态误判把按钮禁用 / 普通权限无提权 | 只认端口监听；提权启动 |
| QQ 报「文件已损坏」 | 注入了版本不匹配的系统 QQ | 注入 NapCat 自带 QQ |
| 端口 3001 不开 | `enable` 默认 false；或用了旧配置启动的实例 | 写入 `enable:true` 后**重启** NapCat |
| 扫码登录后仍无后续 | 登录前的实例未重载新配置 | 完全重启 NapCat |
| 控制台二维码乱码扫不了 | cmd 代码页（GBK）渲染 UTF-8 块字符 | 用 `cache/qrcode.png` 图片扫码 |
| 终端中文乱码 | bat 里含中文 + 编码不一致 | bat 保持纯 ASCII，提示交给应用层 |
| cmd 反复弹开关 | 启动脚本用临时路径且被删除，提权重启时找不到 | 脚本放固定路径、不删除 |
| 登录态失效 | 服务端 Session 过期 | 重走登录链路重新建 JSESSIONID |

---

## 7. 一键管理实现思路（本项目案例）

本项目 `src/core/napcat-manager.ts` 封装了一套一键管理，核心方法可直接复用：

| 方法 | 作用 |
|------|------|
| `detect(dirHint?)` | 探测 NapCat 安装（注册表定位 QQ + 常见布局） |
| `configureForwardWs(uin, port, token)` | 用保守手术在 `onebot11_<uin>.json` 写入正向 WS |
| `start(config)` | 提权启动（生成固定路径 bat → `runAs`） |
| `stop()` | taskkill QQ.exe |
| `status()` | 通过 WS 端口监听判断 NapCat 是否生效 |
| `watchQrcode(shellDir, cb)` | 检测 `cache/qrcode.png` 更新并自动打开 |

### 关键实现要点

- **检测**：优先用注册表定位已安装 QQ（框架自身的真值来源），而非硬编码绝对路径。
- **提权启动**：生成一个**固定路径**（不删除）的 `start-napcat.bat`，内含 `net session` 自检 + `-Verb runAs` 提权。
- **状态判断**：`status()` 只看 **WS 端口是否监听**（`portOpen`），**不要**因为「QQ 进程在跑」就判定 NapCat 已生效。
- **二维码自动打开**：`watchQrcode` 轮询 `cache/qrcode.png` 的 mtime，新出现就调 `shell.openPath` 打开（用户不用手动翻目录）。

---

> 上游源码：https://github.com/NapNeko/NapCatQQ
> 本项目案例：https://github.com/Qi-Lai/scut-notipay-app
