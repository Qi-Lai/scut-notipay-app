const { createFetch, extractCookie, toHttps } = require('./http');

const JW_BASE = 'http://jw2018.jw.scut.edu.cn';
const SSO_BASE = 'https://sso.scut.edu.cn';

/**
 * 教务登录流程：
 *   访问教务 drioLogin -> 跳 SSO CAS -> 用户输账号密码+验证码 -> CAS 发 ticket
 *   -> 回教务 drioLogin?ticket=... -> ticketlogin -> 拿到教务 JSESSIONID
 *
 * 由于 CAS 登录需要图形/短信验证码，本模块把「验证码交给前端显示、用户输入」，
 * 这里分两步：
 *   1. beginLogin(config)  -> 打开 CAS 登录页，返回 {ht, execution, lt, captchaImage?} 供前端呈现
 *   2. submitLogin(config, {username,password,lt,execution,captcha?,code?}) -> 拿教务 JSESSIONID
 *
 * 说明：教务 CAS 支持扫码免密，也可用账号密码+验证码。这里先实现账号密码路径，
 * 验证码图片由前端展示，用户输入后回传。
 */

/**
 * 第一步：发起登录，返回 CAS 登录页需要的字段（lt/execution）和验证码图片（如有）。
 */
async function beginLogin(config) {
  const fetchFn = createFetch(config.proxy);
  // 先访问教务入口，引出 CAS 登录页
  const entryUrl = `${JW_BASE}/sso/driotlogin`;
  let res = await fetchFn(entryUrl, { redirect: 'manual' });
  // 302 到 CAS
  let loc = res.headers.get('location');
  if (loc && loc.startsWith('http:')) loc = toHttps(loc);
  // 或直接构造 CAS URL
  const casUrl = loc || `${SSO_BASE}/cas/login?service=${encodeURIComponent(`${JW_BASE}/sso/driotlogin`)}`;

  res = await fetchFn(casUrl);
  const html = await res.text();

  // 从登录页抓 lt / execution 隐藏字段
  const lt = (html.match(/id="lt"[^>]*value="([^"]+)"/) || [])[1] || '';
  const execution = (html.match(/name="execution"[^>]*value="([^"]+)"/) || [])[1] || '';
  // 提取表单 action（默认 /cas/login + service）
  const action = (html.match(/<form[^>]*action="([^"]+)"/) || [])[1] || '';

  // 尝试抓验证码图片（如果有 <img id="captcha"> 或 /cas/captcha 接口）
  const captchaUrl = (html.match(/<img[^>]*id="[^"]*[Cc]aptcha[^"]*"[^>]*src="([^"]+)"/) || [])[1] || '';
  let captchaBase64 = '';
  if (captchaUrl) {
    try {
      const capRes = await fetchFn(captchaUrl.startsWith('http') ? captchaUrl : `${SSO_BASE}${captchaUrl}`);
      const buf = Buffer.from(await capRes.arrayBuffer());
      captchaBase64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch (e) {
      // ignore
    }
  }

  return { lt, execution, captchaBase64, casUrl, service: encodeURIComponent(`${JW_BASE}/sso/driotlogin`), hasFlow: !!(lt && execution) };
}

/**
 * 第二步：提交登录（POST CAS login），成功则返回教务 JSESSIONID。
 */
async function submitLogin(config, { username, password, lt, execution, captcha, code }) {
  const fetchFn = createFetch(config.proxy);
  // 拼接 POST 目标：CAS action 或 /cas/login?service=...
  const service = encodeURIComponent(`${JW_BASE}/sso/driotlogin`);
  const actionUrl = `${SSO_BASE}/cas/login?service=${service}`;

  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  if (lt) form.append('lt', lt);
  if (execution) form.append('execution', execution);
  form.append('_eventId', 'submit');
  if (captcha) form.append('captcha', captcha);
  if (code) form.append('code', code); // 短信验证码字段（若表单用这个名）

  let res = await fetchFn(actionUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  // 登录成功会 302 回教务 drioLogin?ticket=ST-xxx
  if (res.status !== 302) {
    const text = await res.text();
    // 若返回 200 可能是验证码错误，把提示带回
    const err = text.match(/验证码|错误|失败|不正确|请输/);
    throw new Error(err ? '登录失败，请检查验证码/密码' : `登录失败 HTTP ${res.status}`);
  }

  let loc = res.headers.get('location') || '';
  // 拿 ticket（ST-xxx）
  const ticket = (loc.match(/ticket=(ST-[^&]+)/) || [])[1] || '';

  // 访问教务 drioLogin?ticket=... -> 302 到 ticketlogin -> 建会话
  res = await fetchFn(`${JW_BASE}/sso/driotlogin${ticket ? `?ticket=${ticket}` : ''}`, { redirect: 'manual' });
  let jsessionid = extractCookie(res.headers.get('set-cookie'), 'JSESSIONID');
  if (!jsessionid && res.status === 302) {
    // 302 到 ticketlogin，跟随
    loc = toHttps(res.headers.get('location')) || '';
    res = await fetchFn(loc, { redirect: 'manual' });
    jsessionid = extractCookie(res.headers.get('set-cookie'), 'JSESSIONID');
  }
  if (!jsessionid) {
    throw new Error('登录失败：未获取到教务会话(JSESSIONID)');
  }
  return { jsessionid };
}

module.exports = { beginLogin, submitLogin, JW_BASE, SSO_BASE };
