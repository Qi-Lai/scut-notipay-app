/**
 * 轻量微信推送适配器：Server酱 / pushplus
 * 一次 HTTP 调用，消息经其微信服务号送达用户微信。
 */
async function serverchan(sendKey, title, content) {
  const res = await fetch(`https://sctapi.ftqq.com/${sendKey}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title, desp: content }).toString()
  });
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(`Server酱: ${JSON.stringify(j).slice(0, 150)}`);
}

async function pushplus(token, title, content) {
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content, template: 'txt' })
  });
  const j = await res.json().catch(() => ({}));
  if (j.code !== 200) throw new Error(`pushplus: ${JSON.stringify(j).slice(0, 150)}`);
}

/** 按 config.push.channel 分发。channel: 'serverchan' | 'pushplus' */
async function sendPush(pushCfg, title, content) {
  if (!pushCfg || !pushCfg.channel) throw new Error('未配置 push.channel（serverchan 或 pushplus）');
  if (pushCfg.channel === 'serverchan') {
    if (!pushCfg.sendKey) throw new Error('缺少 push.sendKey（Server酱 SendKey，sct.ftqq.com 获取）');
    return serverchan(pushCfg.sendKey, title, content);
  }
  if (pushCfg.channel === 'pushplus') {
    if (!pushCfg.token) throw new Error('缺少 push.token（pushplus token）');
    return pushplus(pushCfg.token, title, content);
  }
  throw new Error(`未知推送渠道: ${pushCfg.channel}`);
}

module.exports = { sendPush, serverchan, pushplus };
