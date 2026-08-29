#!/usr/bin/env node
/**
 * SCUT 水电费云查询 worker（部署在云服务器，或本机定时跑）
 *
 * 用法:
 *   node worker.js               # 循环模式：立即查一轮，之后每 intervalHours 小时一次
 *   node worker.js --once        # 只查一轮后退出（适合系统 cron / systemd timer）
 *   node worker.js --dry-push    # 本轮推送只打印不发送（测试用，可和 --once 组合）
 *
 * 依赖: 上级仓库 integration-kit（先 `npm --prefix ../integration-kit install && npm --prefix ../integration-kit run build`）
 */
const fs = require('fs');
const path = require('path');
const kit = require('../integration-kit/dist/index.js');
const { sendPush } = require('./push');

const ROOT = __dirname;
const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const DRY_PUSH = args.includes('--dry-push');

const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

const config = readJson(CONFIG_PATH, null);
if (!config || !Array.isArray(config.accounts) || config.accounts.length === 0) {
  console.error('[config] 缺少 config.json 或 accounts 为空。');
  console.error('        请复制 config.example.json 为 config.json 并填写账号/阈值/推送配置。');
  process.exit(1);
}

const state = readJson(STATE_PATH, {});
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const log = (level, msg) =>
  console.log(`[${new Date().toLocaleString('zh-CN')}] [${level}] ${msg}`);

const kitConfig = () => kit.defaultConfig({ proxy: config.proxy || '' });

/** 单账号完整查询：一卡通登录 → dfyc 登录链 → 余额查询 */
async function queryAccount(acc) {
  const kc = kitConfig();
  const login = await kit.obtainToken(acc.cardId, acc.password, kc);
  if (!login) throw new Error('一卡通登录失败（学号或查询密码错误？）');
  const jsessionid = await kit.dfycLogin(login.access_token, login.TGC, login.locSession, kc);
  return await kit.dfycQueryBills(jsessionid, kc);
}

/** 阈值判定 + 推送节流。返回需要推送的告警文案列表 */
function evaluate(acc, bills, accState, now) {
  const minRepeatH = (config.push && config.push.minRepeatHours) ?? 24;
  const checks = [
    { type: 'electric', label: '⚡ 电费', value: bills.electric, threshold: acc.electricThreshold },
    { type: 'water', label: '💧 水费', value: bills.water, threshold: acc.waterThreshold }
  ].filter((c) => typeof c.threshold === 'number');

  const messages = [];
  const fired = []; // 本次应推送的告警状态（推送成功后才写 lastPushAt）
  accState.alerts = accState.alerts || {};
  for (const c of checks) {
    const low = c.value <= c.threshold;
    const st = (accState.alerts[c.type] = accState.alerts[c.type] || { low: false, lastPushAt: 0 });
    const hoursSince = (now - st.lastPushAt) / 3600000;
    // 低于阈值时：首次立刻推；持续低则每 minRepeatH 小时提醒一次，避免刷屏
    const shouldPush = low && (!st.low || hoursSince >= minRepeatH);
    st.low = low;
    if (shouldPush) {
      messages.push(`${c.label} ${c.value.toFixed(2)} 元，已低于阈值 ${c.threshold} 元`);
      fired.push(st);
    }
  }
  return { messages, fired };
}

async function processAccount(acc, dryPush) {
  const accState = (state[acc.cardId] = state[acc.cardId] || {});
  const now = Date.now();
  try {
    const bills = await queryAccount(acc);
    accState.failCount = 0;
    accState.last = { electric: bills.electric, water: bills.water, room: bills.room, at: now };
    log(
      'info',
      `${acc.name || acc.cardId} ${bills.room}: 电 ${bills.electric.toFixed(2)} / 水 ${bills.water.toFixed(2)}`
    );

    const { messages, fired } = evaluate(acc, bills, accState, now);
    if (messages.length) {
      const title = `⚡️宿舍费用提醒（${bills.room}）`;
      const content =
        `🏠 ${bills.room}\n` +
        messages.join('\n') +
        `\n\n⚡ 电费 ${bills.electric.toFixed(2)} 元\n💧 水费 ${bills.water.toFixed(2)} 元` +
        `\n🕐 ${new Date(now).toLocaleString('zh-CN')}`;
      if (dryPush) {
        log('dry', `（dry-push）${title}\n${content}`);
        fired.forEach((st) => (st.lastPushAt = now));
      } else {
        try {
          await sendPush(config.push, title, content);
          // 推送成功才记节流时间；失败不记，下轮自动重试
          fired.forEach((st) => (st.lastPushAt = now));
          log('success', `已推送: ${messages.join('；')}`);
        } catch (e) {
          log('error', `推送失败: ${e.message}`);
        }
      }
    }
  } catch (e) {
    accState.failCount = (accState.failCount || 0) + 1;
    log('error', `${acc.name || acc.cardId} 查询失败(连续${accState.failCount}次): ${e.message}`);
    // 连续失败 ≥3 次时告警一次（24h 节流），提醒密码可能改了/网络不可达
    if (accState.failCount >= 3) {
      accState.alerts = accState.alerts || {};
      const err = (accState.alerts.error = accState.alerts.error || { lastPushAt: 0 });
      if ((now - err.lastPushAt) / 3600000 >= 24) {
        const title = `⚠️水电费查询连续失败（${acc.name || acc.cardId}）`;
        const content = `已连续 ${accState.failCount} 次查询失败。\n最近错误: ${e.message}\n请检查查询密码是否修改、服务器到校园系统网络是否可达。`;
        if (dryPush) {
          log('dry', `（dry-push）${title}\n${content}`);
          err.lastPushAt = now;
        } else {
          try {
            await sendPush(config.push, title, content);
            err.lastPushAt = now; // 成功才记节流
          } catch (pushErr) {
            log('error', `失败告警推送未送达: ${pushErr.message}`);
          }
        }
      }
    }
  }
}

async function runOnce() {
  log('info', `开始查询（${config.accounts.length} 个账号${DRY_PUSH ? '，dry-push' : ''}）`);
  for (const acc of config.accounts) {
    await processAccount(acc, DRY_PUSH);
  }
  saveState();
  log('info', '本轮查询完成');
}

async function main() {
  if (ONCE) {
    await runOnce();
    return;
  }

  // 固定时刻模式：config.queryHours = ["0800", "2015"]（HHMM，精确到分钟）
  if (Array.isArray(config.queryHours) && config.queryHours.length) {
    // 归一化为 HHMM：容忍 "8:00" / 800 / "0800" 等写法
    const norm = [
      ...new Set(
        config.queryHours
          .map((v) => String(v).replace(/\D/g, '').padStart(4, '0'))
          .filter((t) => Number(t.slice(0, 2)) <= 23 && Number(t.slice(2)) <= 59)
      )
    ].sort();
    if (!norm.length) {
      log('warn', 'queryHours 配置无效（应为 HHMM，如 ["0800","2015"]），退回 intervalHours 模式');
    } else {
      const times = norm.map((t) => `${t.slice(0, 2)}:${t.slice(2)}`).join('、');
      log('info', `循环模式：每天 ${times} 查询（queryHours）`);
      let lastRunKey = ''; // 防止同一时刻重复跑
      setInterval(async () => {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        if (!norm.includes(hhmm)) return;
        const key = `${now.toDateString()} ${hhmm}`;
        if (key === lastRunKey) return;
        lastRunKey = key;
        await runOnce();
      }, 30 * 1000);
      return;
    }
  }

  // 间隔模式（默认）：每 intervalHours 小时一次
  const hours = config.intervalHours ?? 6;
  log('info', `循环模式：每 ${hours} 小时查询一次`);
  await runOnce();
  setInterval(() => {
    void runOnce();
  }, hours * 3600000);
}

main().catch((e) => {
  log('error', e.message);
  process.exit(1);
});
