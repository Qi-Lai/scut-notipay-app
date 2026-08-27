# SCUT NotiPay 管理面板（桌面端）

华南理工大学宿舍缴费查询与提醒机器人 **scut-notipay** 的桌面管理端。
机器人本体运行在本应用内，提供图形化管理面板，替代纯 QQ 命令行交互。

> 上游项目：[Naptie/scut-notipay](https://github.com/Naptie/scut-notipay)（MPL-2.0）

> 📘 开发参考：[NapCat 技术参考文档](docs/napcat-guide.md)（面向后续所有 NapCat 项目的通用知识，如 OneBot11 配置、登录认证、启动方式、常见坑）

## 功能

- **NapCat 一键管理**：（本仓库新增）自动检测本机 NapCat 安装、一键启动、自动开启正向 WebSocket 端口并同步 token。无需手动编辑 OneBot 配置。
- **整点自动采集**：每小时自动登录校园一卡通系统，抓取绑定用户的宿舍账单（电费 / 水费 / 空调费）。
- **QQ 定时提醒**：按用户设置的通知计划，将余额报告（文字 + 趋势图）推送到 QQ 私聊或群聊。
- **图形化管理面板**：（本仓库新增，纯桌面 UI）
  - 仪表盘：NapCat 状态、机器人状态、用户 / 通知 / 记录统计、下次任务时间。
  - 用户管理：绑定 / 解绑学生账号、实时查询账单、查看历史账单趋势图、调整更新间隔。
  - 通知计划：为每个用户设置每日推送时间、余额阈值、通知项目。
  - 运行日志：实时查看机器人运行日志（级别过滤、暂停滚动、清空）。
  - 设置：NapCat 目录与连接配置、触发命令、查询重试次数、SOCKS / HTTP 代理、自动连接。
- **本地数据安全**：卡片密码以 AES-256-GCM 加密后存储于本地 SQLite（`data.db`），加密密钥在数据目录的 `config.json`（首次启动自动生成）。

## 工作原理

```
NapCat (QQ协议端) <──WebSocket──┐
                               ▼
                    本应用内嵌机器人 (node-napcat-ts)
                               │ 定时/手动
                               ▼
              华南理工校园一卡通 OAuth 登录
              抓取 GZIC / DXC 校区宿舍账单
                               │
                               ▼
        SQLite 存储 凭据/账单历史/通知计划 ──> Chart.js 生成趋势图 ──> 推送到 QQ
```

与上游的差异：
- 上游用 `node-canvas` 在 Node 端生成图表，本应用改为 **Electron 隐藏窗口 + Chart.js 离屏渲染**（避免原生 canvas 依赖，跨平台无需编译工具链）。
- 上游 `config.json` 硬编码在项目根目录，本应用改为**运行时可读写**、存于系统用户数据目录，并可从 UI 编辑。
- **新增 NapCat 一键管理**：自动检测本机安装（注册表 + 常见目录）、一键拉起 QQ + NapCat、自动开启正向 WebSocket 端口并同步令牌。配置写入用「保育式手术」——只翻转目标 WebSocket 条目，保留所有其他（含未来新增）字段，避免不同 NapCat 版本配置格式差异导致写坏。
- 新增完整的 GUI 管理面板与进程生命周期管理（托盘常驻、单实例锁、优雅退出）。

## 环境要求

- Node.js 18+（建议 20/22）
- **NapCat**（QQ 机器人协议端，可选——应用可自动检测本机安装；若无安装仍需手动获取）

## 本地开发 / 构建

```bash
npm install        # 自动执行 electron-rebuild 重建 better-sqlite3
npm run start      # 编译 + 启动应用（开发）
npm run dist       # 打包 Windows NSIS 安装包 + 便携版 → release/
```

## 使用步骤

1. 打开本应用，「仪表盘」的 **NapCat 卡片会自动检测本机安装**（已检测到会显示目录）。若未安装，请先获取 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 Windows OneKey 包并解压。
2. 首页点 **「一键启动 NapCat」**：应用会自动开启 NapCat 的正向 WebSocket（默认 `127.0.0.1:3001`）、写入访问令牌并拉起 QQ；
   - 首次使用若提示「待登录」，NapCat 会弹出扫码窗口，用 QQ 扫码登录一次即可。
3. 「仪表盘」的机器人区点 **「启动」**，机器人状态变为「在线」。
4. 「用户管理」→「绑定用户」，输入学生 QQ 号、一卡通卡号、密码、校区（GZIC / DXC）。
5. 机器人开始每小时整点自动采集并按通知计划推送。

> 也可在「设置」页手动指定 NapCat 目录 / WebSocket 地址 / 令牌，平台自动检测失败时用。

也可照旧在 QQ 私聊机器人发命令（默认触发词 `scut-notipay` / `snp`）：
```
snp bind <卡号> <密码> <校区>          # 绑定
snp query                              # 查询当前账单
snp notify <小时> [阈值] [项目]          # 设置定时通知
snp interval 12h                       # 设置更新间隔
snp help                               # 全部命令
```

## 数据存放位置

- **Windows**：`%APPDATA%\scut-notipay-app\`
  - `config.json`：应用配置（含加密密钥）
  - `data.db`：SQLite 数据库（用户凭据、账单历史、通知计划）

> 请勿将数据目录发送给他人。

## 打包产物

`npm run dist` 生成 `release/` 文件夹：
- `SCUT NotiPay-Setup-<version>.exe`（NSIS 安装包，可选安装目录）
- `SCUT NotiPay-Portable-<version>.exe`（免安装便携版）

## 技术栈

- Electron 37 · TypeScript 5.9
- Chart.js 4 + 离屏 Chromium 渲染
- better-sqlite3（原生模块，随包分发）
- node-napcat-ts（NapCat QQ 协议）
- electron-builder 26

## ⚠️ 免责声明（纯 Vibe Coding 项目）

**本项目是完全通过 "Vibe Coding"（AI 辅助/驱动编码）方式产出的作品。** 这意味着：

- **不以生产级/商业级软件标准交付**。本项目**不提供任何形式的功能保障、性能保障、稳定性保障或安全性保障**。
- 可能存在未发现的 bug、边界情况未覆盖、性能瓶颈、安全漏洞等问题。
- 代码未经严格的测试、代码审查或安全审计。
- 使用本项目（尤其是涉及真实金钱的充值功能、QQ 账号自动化等）所产生的一切后果，由使用者自行承担。**请勿用于与金钱直接相关的自动化操作**。

**你使用本项目即表示你理解并接受上述风险。** 请务必在本地、用可牺牲的账号做充分测试后再决定是否实际使用。

## License

MPL-2.0。上游核心逻辑版权归 Naptie/scut-notipay 原作者所有。

本项目基于上游项目 [Naptie/scut-notipay](https://github.com/Naptie/scut-notipay)（MPL-2.0）进行修改与扩展，并遵循 MPL-2.0 许可证发布。上游代码的版权归原作者所有；本项目新增的 UI、NapCat 一键管理等功能在遵守 MPL-2.0 的前提下随项目一同发布。
