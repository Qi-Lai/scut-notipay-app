# 水电费云查询服务（cloud/）

把宿舍水电费查询部署到云服务器，定时查询余额、低于阈值时推送微信提醒。
复用仓库根目录的 `integration-kit/`（一卡通登录 + dfyc 查询链路，已实测可用）。

## 推送渠道

**Server酱** 或 **pushplus**（二选一，一次 HTTP 调用，消息经其微信服务号到达微信）：

- Server酱：https://sct.ftqq.com 微信扫码登录 → 获取 SendKey → 填入 `push.sendKey`
- pushplus：https://www.pushplus.plus 登录 → 获取 token → `channel` 改为 `pushplus` 并填 `push.token`

> 曾考虑微信官方 ClawBot（OpenClaw），但其出站消息由 AI 智能体回复触发、无独立推送 API，为发通知常驻 AI 网关太重，弃用。

## 本地运行 / 测试

```bash
# 1) 先构建 integration-kit（仓库根目录）
npm --prefix ../integration-kit install
npm --prefix ../integration-kit run build

# 2) 配置
cp config.example.json config.json   # 填入一卡通卡号/查询密码/推送 key

> ⚠️ **`cardId` 是「一卡通卡号」，不是学号！** 卡号可在「SCUT 企业微信/一卡通 App」或绑定时的信息里查到（形如 6 位数字）。填学号会报「用户名或密码错误」。

# 3) 跑一轮（推送只打印不发送，用于验证）
node worker.js --once --dry-push

# 4) 正式单轮（真实推送）
node worker.js --once

# 5) 常驻循环（每 intervalHours 小时一次）
node worker.js
```

`--dry-push` 模式下，真实登录 + 真实查询会执行，只有推送是打印到控制台。

## 腾讯云部署步骤

### 0) 购买建议 + 验证可达性

**镜像选 Ubuntu Server 22.04 LTS（64位）**（本指南按 Debian/Ubuntu 系编写；CentOS/TencentOS 是 yum 系需自行换命令，Windows 无必要）。地域建议广州（离华工近，到教育网路由好）；能勾 IPv6 就勾（兜底校内系统 CERNET 可达性）。安全组放行 22（SSH）即可——worker 只出站，不监听公网。

> **应用镜像说明**：应用镜像 = 系统镜像 + 预装配置好的软件栈（开机即用）。本项目用**纯系统镜像**即可；「Web开发 → Node.js」应用镜像也可接受（省去装 Node 一步，但需确认其 Node ≥ 20）。其余类别（龙虾/AI/建站面板/Docker 等）与本服务无关：OpenClaw 类已弃用，宝塔等面板徒增攻击面和内存占用。

云服务器在公网，**必须先确认它能访问校园系统**（本机测试可达不代表云上也可达，校园系统走 CERNET IPv6 时尤其要注意）：

```bash
curl -m 10 -o /dev/null -w "%{http_code}\n" https://dfyc.utc.scut.edu.cn/
curl -m 10 -o /dev/null -w "%{http_code}\n" https://ecardwxnew.scut.edu.cn/
```

两个都返回 404/302/200 等 HTTP 状态（而非超时）即可。**若超时**：在腾讯云控制台给实例启用 **IPv6**（校园系统解析到 CERNET IPv6，公网 IPv6 通常可达），并给 Node 进程配好 IPv6 出口；或换有 IPv6 的网络方案。

### 1) 装环境

```bash
# Node.js 20+（以 NodeSource 为例）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

### 2) 拉代码 + 构建

```bash
sudo mkdir -p /opt/scut-notipay && sudo chown $USER /opt/scut-notipay
git clone https://github.com/Qi-Lai/scut-notipay-app.git /opt/scut-notipay
cd /opt/scut-notipay
npm --prefix integration-kit install
npm --prefix integration-kit run build
cd cloud
cp config.example.json config.json   # 填写账号/阈值/推送 key（此文件已被 gitignore，不会提交）
```

### 3) 手动跑一轮验证

```bash
node worker.js --once --dry-push    # 验证登录/查询/推送内容
node worker.js --once               # 真实推送一条到微信
```

### 4) 调度时间（二选一配置）

**固定时刻模式**（推荐）：`config.json` 里配 `queryHours`（**HHMM 格式，精确到分钟**），每天在指定时刻查询：

```json
"queryHours": ["0800", "2015"]     // 每天 08:00 和 20:15 各查一次
```

> 写法容忍 `"0800"` / `"8:00"` / `800`，统一归一化为 HHMM；非法时刻（如 25:00）自动忽略。

**间隔模式**（默认）：配 `intervalHours`，启动后立即查一次，之后每 N 小时一次：

```json
"intervalHours": 6        // 每 6 小时一次（具体钟点取决于服务启动时间）
```

> 两个字段都在时**优先用 `queryHours`**。改完配置要重启服务：`sudo systemctl restart scut-billing`

### 5) 常驻（systemd）

```bash
sudo cp scut-billing.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scut-billing
systemctl status scut-billing        # 确认 active (running)
journalctl -u scut-billing -f        # 看实时日志
```

> 也可不用常驻，改用系统 crontab（固定时刻的另一种写法）：`0 8,20 * * * cd /opt/scut-notipay/cloud && /usr/bin/node worker.js --once`

## 安全注意

- `config.json` 含**查询密码明文**，已被 gitignore，**不要提交、不要外发**；服务器权限收紧（`chmod 600 config.json`）。
- 阈值告警有节流（`minRepeatHours`，默认 24h），不会刷屏。
- 云服务器 IP 登录一卡通属异地登录，校园系统无 QQ 那类强风控，但如果收到学校异常提醒请降低频率或停用。

## 费用/资源评估

- 每轮查询约 9 个 KB 级请求 ≈ 50KB；每小时一轮 ≈ 45MB/月流量（500G 配额的 0.1% 不到）
- Node worker 内存约 50-100MB，2C2G 即可跑，4C4G 有大量余量
- 3Mbps 带宽无压力（非对外 web 服务）
