const store = require('./store');
const auth = require('./auth');
const jwxt = require('./jwxt');

/**
 * 业务编排层：把 auth / jwxt / store 串起来，供 server 的 API 调用。
 * 状态机：CONFIG -> LOGIN -> WAIT(轮询探测) -> LIST(展示名单) -> SUBMIT(提交中) -> DONE/STOP
 */

async function beginLogin() {
  const cfg = store.get();
  if (cfg.login.inProgress) return { error: '登录已在进行中' };
  cfg.login.inProgress = true;
  store.setPhase('LOGIN');
  store.addLog('info', '正在发起登录...');
  try {
    const res = await auth.beginLogin(cfg.config);
    if (!res.hasFlow) {
      store.addLog('warn', '未能获取登录表单（可能需要扫码或验证码缺失）');
    }
    store.setLogin({ lt: res.lt, execution: res.execution, captchaBase64: res.captchaBase64 });
    cfg.login.inProgress = false;
    return res;
  } catch (e) {
    cfg.login.inProgress = false;
    store.addLog('error', `发起登录失败: ${e.message}`);
    throw e;
  }
}

async function submitLogin({ username, password, lt, execution, captcha }) {
  const cfg = store.get();
  try {
    const { jsessionid } = await auth.submitLogin(cfg.config, {
      username,
      password,
      lt,
      execution,
      captcha
    });
    store.setLogin({ jsessionid });
    store.setPhase('WAIT');
    store.addLog('success', '登录成功，已获得教务会话');
    return { jsessionid };
  } catch (e) {
    store.addLog('error', `登录失败: ${e.message}`);
    throw e;
  }
}

/** 检查一次是否开放（返回课程数） */
async function checkOpen() {
  const cfg = store.get();
  const { jsessionid } = cfg.login;
  if (!jsessionid) throw new Error('未登录');
  try {
    const data = await jwxt.queryCourses(jsessionid, cfg.config);
    const count = Number(data.totalResult || data.queryModel?.totalCount || 0);
    cfg.wait.lastCourseCount = count;
    cfg.wait.lastCheckAt = Date.now();
    store.addLog('info', `检查选课开放: ${count > 0 ? `已开放，共 ${count} 门课` : '未开放 (仍在等待)'}`);
    return { open: count > 0, count };
  } catch (e) {
    store.addLog('error', `检查失败: ${e.message}`);
    return { open: false, count: 0, error: e.message };
  }
}

/** 开启轮询（WAIT -> 开放后进入 LIST 并抓课程列表） */
async function startWait() {
  const cfg = store.get();
  if (cfg.wait.running) return;
  cfg.wait.running = true;
  store.setPhase('WAIT');
  store.addLog('info', '开始轮询选课开放状态...');

  const tick = async () => {
    if (!cfg.wait.running) return;
    const { open, count } = await checkOpen();
    if (open) {
      cfg.wait.running = false;
      store.setPhase('LIST');
      store.addLog('success', '选课已开放！正在加载课程名单...');
      await loadCourses();
    }
  };
  await tick();
  cfg.wait.timer = setInterval(tick, 4000); // 每 4 秒查一次
}

async function stopWait() {
  const cfg = store.get();
  if (cfg.wait.timer) clearInterval(cfg.wait.timer);
  cfg.wait.timer = null;
  cfg.wait.running = false;
}

/** 抓取并解析课程列表，存入 store.courses */
async function loadCourses() {
  const cfg = store.get();
  try {
    const data = await jwxt.queryCourses(cfg.login.jsessionid, cfg.config);
    // 正方标准：itemList 里是课程项
    const list = data.itemList || data.items || [];
    const courses = list.map((c) => {
      const kch = c.kch || c.kch_id || ''; // 课程号
      const kcm = c.kcmc || c.kcm || ''; // 课程名
      const jxbm = c.jxbmc || ''; // 教学班名称
      const kkbmmc = c.kkbmmc || ''; // 开课部门
      const ksm = c.ksm || ''; // 教师
      const xf = c.xf || ''; // 学分
      const kctj = c.kctj || ''; // 具体情况（课表）
      return { kch, kcm, jxbm, kkbmmc, ksm, xf, kctj, params: c };
    });
    store.setCourses(courses);
    store.addLog('info', `已加载 ${courses.length} 门课程`);
    return courses;
  } catch (e) {
    store.addLog('error', `加载课程失败: ${e.message}`);
    throw e;
  }
}

/** 温和并发提交一轮（每个目标课 POST 一次），返回本轮结果 */
async function submitOneRound() {
  const cfg = store.get();
  const { jsessionid } = cfg.login;
  if (!jsessionid) throw new Error('未登录');
  if (!cfg.targets.length) throw new Error('未选择目标课');

  const courses = cfg.courses;
  const targetList = cfg.targets.map((t) =>
    typeof t === 'object' ? t : courses.find((c) => c.kch === t)
  );
  const results = [];
  for (const course of targetList) {
    if (!course) continue;
    // 从 params 里提取提交参数（教学班号等），提交键名选课后实测校准
    const submitParams = {
      kch: course.kch,
      // 常见正方选课提交字段
      xklxbm: 'N253512', // 选课类别代码（这里用当前功能模块）
      ...extractSubmitParams(course.params)
    };
    try {
      const r = await jwxt.submitCourse(jsessionid, cfg.config, submitParams);
      store.setSubmitStatus(course.kch, { status: r.ok ? 'success' : 'fail', lastError: r.message, attempts: (cfg.submitStatus[course.kch]?.attempts || 0) + 1 });
      results.push({ kch: course.kch, ok: r.ok, message: r.message });
    } catch (e) {
      store.setSubmitStatus(course.kch, { status: 'fail', lastError: e.message, attempts: (cfg.submitStatus[course.kch]?.attempts || 0) + 1 });
      results.push({ kch: course.kch, ok: false, message: e.message });
    }
  }
  return results;
}

/** 从课程项提取提交所需字段（做过多的字段，保留原样传给提交接口） */
function extractSubmitParams(params) {
  const keepKeys = ['jxbid', 'kch', 'kcmc', 'jxbmc', 'kkbmmc', 'kctj', 'kcgs', 'kcbh', 'xqbm', 'xqmc', 'kkyxq'];
  const out = {};
  for (const k of keepKeys) {
    if (params && params[k] != null) out[k] = params[k];
  }
  return out;
}

/** 开始提交循环（温和：每轮之间 sleep jitter） */
async function startSubmit(intervalMs = 800) {
  const cfg = store.get();
  if (cfg.submitRunning) return;
  cfg.submitRunning = true;
  store.setPhase('SUBMIT');
  store.clearSubmitStatus();
  store.addLog('info', '开始提交选课（温和并发）...');

  const run = async () => {
    while (cfg.submitRunning) {
      const rs = await submitOneRound();
      const allSuccess = rs.every((r) => r.ok);
      store.addLog('info', `提交一轮: ${rs.filter(r=>r.ok).length} 成功 / ${rs.filter(r=>!r.ok).length} 失败`);
      if (allSuccess) {
        store.setPhase('DONE');
        cfg.submitRunning = false;
        store.addLog('success', '所有目标课已提交成功');
        break;
      }
      // 温和抖动 0.5~1.2 秒
      const jitter = intervalMs + Math.random() * 400;
      await new Promise((r) => setTimeout(r, jitter));
    }
  };
  void run();
}

function stopSubmit() {
  const cfg = store.get();
  cfg.submitRunning = false;
  if (cfg.submitTimer) clearInterval(cfg.submitTimer);
  store.setPhase(cfg.submitStatus && Object.keys(cfg.submitStatus).length ? 'DONE' : 'STOP');
}

module.exports = {
  beginLogin,
  submitLogin,
  checkOpen,
  startWait,
  stopWait,
  loadCourses,
  startSubmit,
  stopSubmit
};
