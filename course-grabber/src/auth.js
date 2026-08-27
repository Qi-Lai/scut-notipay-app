const { createFetch, extractCookie, toHttps } = require('./http');

const JW_BASE = 'http://jw2018.jw.scut.edu.cn';
const SSO_BASE = 'https://sso.scut.edu.cn';
// 微信服务号 appid（从 CAS 页面提取）
const WX_APPID = 'wx39f121ed798af736';
// 微信 OAuth 回调到 CAS 的地址
const WX_REDIRECT = `${SSO_BASE}/cas/scutwxsso`;

/* ================= 账号密码 + 验证码 登录 ================= */

/** 第一步：发起账号密码登录，返回 lt/execution（供前端呈现验证码输入） */
async function beginLogin(config) {
  const fetchFn = createFetch(config.proxy);
  const service = encodeURIComponent(`${JW_BASE}/sso/driotlogin`);
  const casUrl = `${SSO_BASE}/cas/login?service=${service}`;
  const res = await fetchFn(casUrl);
  const html = await res.text();
  const lt = (html.match(/id="lt"[^>]*value="([^"]+)"/) || [])[1] || '';
  const execution = (html.match(/name="execution"[^>]*value="([^"]+)"/) || [])[1] || '';
  return { lt, execution, casUrl, service, hasFlow: !!(lt && execution) };
}

/** 第二步：提交账号密码 + 验证码，登录成功拿教务 JSESSIONID */
async function submitLogin(config, { username, password, lt, execution, captcha }) {
  const fetchFn = createFetch(config.proxy);
  const service = encodeURIComponent(`${JW_BASE}/sso/driotlogin`);
  const actionUrl = `${SSO_BASE}/cas/login?service=${service}`;
  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  if (lt) form.append('lt', lt);
  if (execution) form.append('execution', execution);
  form.append('_eventId', 'submit');
  if (captcha) form.append('captcha', captcha);

  const res = await fetchFn(actionUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (res.status !== 302) {
    const text = await res.text();
    throw new Error(/验证码|错误|失败|不正确/.test(text) ? '登录失败，请检查验证码/密码' : `登录失败 HTTP ${res.status}`);
  }
  const loc = res.headers.get('location') || '';
  const ticket = (loc.match(/ticket=(ST-[^&]+)/) || [])[1] || '';
  return await finishLogin(config, ticket);
}

/* ================= 微信扫码登录 ================= */

/** 生成 uuid */
function genUuid() {
  let d = Date.now();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (d + Math.random() * 16) % 16 | 0;
    d = Math.floor(d / 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * 发起扫码登录：生成 uuid + 微信 OAuth 二维码内容。
 * 前端用二维码内容渲染二维码（微信扫码 → 回调 scutwxsso → CAS 登录 → 返回 ticket）。
 */
async function startQrLogin(config) {
  const uuid = genUuid();
  // 微信 OAuth authorize URL，微信扫码后回调 sso 的 scutwxsso?state=<uuid>
  // 二维码内容就是 URL，扫码->微信内置 OAuth。
  const qrContent =
    `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${WX_APPID}` +
    `&redirect_uri=${encodeURIComponent(WX_REDIRECT)}&response_type=code&scope=snsapi_base&state=${uuid}#wechat_redirect`;
  return { uuid, qrContent };
}

/**
 * 轮询扫码状态：每 pollMs 一次，直到非 -1/0（扫码成功）或超时。
 * 返回 result（扫码成功返回 ticket 标识），超时返回 null。
 */
async function pollQr(config, uuid, { timeoutMs = 60000, pollMs = 1500 } = {}) {
  const fetchFn = createFetch(config.proxy);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 用 jsonp 语义的 jsonpcallback 参数（CAS 返回 cb(result)）
    const res = await fetchFn(`${SSO_BASE}/cas/scutqqcheck?uuid=${uuid}&jsonpcallback=cb`);
    const text = await res.text();
    // text 形如 "cb(-1)" / "cb(0)" / "cb(ST-xxx)" 或 "cb(...)"
    const m = text.match(/cb\(([^)]*)\)/);
    if (m) {
      const val = m[1];
      if (val !== '-1' && val !== '0' && val !== 'null' && val !== '') {
        return val; // 扫码成功（通常是 ticket）
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** 用 ticket（扫码或账号密码登录得到）走教务登录，拿 JSESSIONID */
async function finishLogin(config, ticket) {
  const fetchFn = createFetch(config.proxy);
  if (!ticket) throw new Error('未获取到 ticket，登录失败');
  let res = await fetchFn(`${JW_BASE}/sso/driotlogin?ticket=${ticket}`, { redirect: 'manual' });
  let jsessionid = extractCookie(res.headers.get('set-cookie'), 'JSESSIONID');
  if (!jsessionid && res.status === 302) {
    const loc = toHttps(res.headers.get('location')) || '';
    res = await fetchFn(loc, { redirect: 'manual' });
    jsessionid = extractCookie(res.headers.get('set-cookie'), 'JSESSIONID');
  }
  if (!jsessionid) throw new Error('登录失败：未获取到教务会话(JSESSIONID)');
  return { jsessionid, ticket };
}

module.exports = {
  beginLogin,
  submitLogin,
  startQrLogin,
  pollQr,
  finishLogin,
  JW_BASE,
  SSO_BASE
};
