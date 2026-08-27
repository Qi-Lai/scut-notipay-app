const api = async (p, opts) => {
  const res = await fetch(p, {
    headers: { 'Content-Type': 'application/json' },
    ...(opts || {})
  });
  return res.json();
};

const $ = (id) => document.getElementById(id);
const PHASE = {
  CONFIG: ['未登录', '#666'],
  LOGIN: ['登录中', '#d9a13b'],
  WAIT: ['探测选课开放中', '#d9a13b'],
  LIST: ['选课已开放，等待选择', '#3fb950'],
  SUBMIT: ['提交中', '#4f6ef7'],
  DONE: ['已完成', '#3fb950'],
  STOP: ['已停止', '#666']
};

function setPhase(phase) {
  const [text, color] = PHASE[phase] || [phase, '#666'];
  $('phase-text').textContent = text;
  $('phase-dot').style.background = color;
}

function show(id, show) {
  $(id).classList.toggle('hidden', !show);
}

async function refreshState() {
  try {
    const s = await api('/api/state');
    setPhase(s.phase);
    const logged = s.login.jsessionid;
    show('sec-login', !logged);
    show('sec-wait', logged && s.phase !== 'DONE');
    show('sec-list', logged && (s.phase === 'LIST' || s.phase === 'SUBMIT' || s.phase === 'DONE'));
    show('sec-submit', !!s.submitRunning || s.phase === 'SUBMIT');
    if (logged) $('course-count').textContent = s.courses?.length ? `已加载 ${s.courses.length} 门课` : '';
    renderLog(s.wait.log);
    renderCourses(s.courses);
    renderSubmitStatus(s.submitStatus);
    if (s.login.captchaBase64) {
      show('captcha-area', true);
      $('captcha-img').src = s.login.captchaBase64;
    } else {
      show('captcha-area', false);
    }
  } catch (e) {
    console.error(e);
  }
}

function renderLog(log) {
  const el = $('log');
  el.innerHTML = (log || [])
    .map((l) => `<div class="log-line ${l.level}">[${new Date(l.t).toLocaleTimeString()}] ${l.msg}</div>`)
    .join('');
  el.scrollTop = el.scrollHeight;
}

function renderCourses(courses) {
  const el = $('course-list');
  if (!courses || !courses.length) {
    el.innerHTML = '<div class="empty">暂无课程（可能尚未开放，或未加载）。</div>';
    return;
  }
  el.innerHTML = courses
    .map((c, i) => {
      const teacher = c.ksm || c.kkbmmc || '';
      return `<label class="course-item">
        <input type="checkbox" value="${c.kch}" data-idx="${i}">
        <span class="course-body">
          <strong>${c.kcm || c.kch}</strong>
          <em>${[c.jxbm, teacher, c.xf ? '学分 ' + c.xf : ''].filter(Boolean).join(' · ')}</em>
        </span>
      </label>`;
    })
    .join('');
}

function renderSubmitStatus(map) {
  const el = $('submit-status');
  const courses = window._courses || [];
  const names = {};
  (courses || []).forEach((c) => (names[c.kch] = c.kcm || c.kch));
  const entries = Object.entries(map || {});
  if (!entries.length) {
    el.innerHTML = '<div class="empty">尚未开始提交。</div>';
    return;
  }
  el.innerHTML = entries
    .map(
      ([kch, st]) =>
        `<div class="submit-item">
          <span>${names[kch] || kch}</span>
          <em class="st-${st.status}">${st.status === 'success' ? '✓ 成功' : st.status === 'fail' ? '✗ 失败' : '提交中'}${st.attempts ? ` (${st.attempts}次)` : ''}</em>
          ${st.lastError ? `<small>${st.lastError}</small>` : ''}
        </div>`
    )
    .join('');
}

// ---- events ----
$('btn-scan').addEventListener('click', async () => {
  $('login-msg').textContent = '正在生成二维码...';
  const r = await api('/api/login/scan', { method: 'POST' });
  if (r.ok && r.qrContent) {
    window._qrContent = r.qrContent;
    $('scan-msg').textContent = '请用微信扫一扫登录（约 1 分钟内有效）';
    renderQr(r.qrContent);
    startQrPoll();
  } else {
    $('login-msg').textContent = r.error || '发起扫码失败';
  }
});

function renderQr(content) {
  // 用二维码图片 API 渲染（goqr.me），无需本地 QR 库
  const img = $('qr-img');
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(content)}`;
  img.style.display = 'block';
}

function startQrPoll() {
  if (window._qrPoll) clearInterval(window._qrPoll);
  $('login-msg').textContent = '等待扫码...';
  // 轮询后端（后端阻塞到扫码成功，但为了不卡前端，用短轮询探测状态）
  window._qrPoll = setInterval(async () => {
    const r = await api('/api/login/scan-poll', { method: 'POST' });
    if (r.ok) {
      clearInterval(window._qrPoll);
      window._qrPoll = null;
      $('login-msg').textContent = '登录成功！';
      await refreshState();
    } else if (r.error && /超时/.test(r.error)) {
      clearInterval(window._qrPoll);
      window._qrPoll = null;
      $('scan-msg').textContent = '二维码已失效，请重新生成';
    }
  }, 1500);
}

$('btn-login').addEventListener('click', async () => {
  $('login-msg').textContent = '正在发起登录...';
  await api('/api/config', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value, proxy: $('proxy').value.trim() }) });
  const r = await api('/api/login/begin', { method: 'POST' });
  if (r.ok && r.hasFlow) {
    $('login-msg').textContent = '请填写验证码后提交（下面）。';
    show('captcha-area', !!r.captchaBase64);
    if (r.captchaBase64) $('captcha-img').src = r.captchaBase64;
    // 保存 lt/execution 在内存变量，提交时带上
    window._flow = r;
  } else if (r.ok) {
    $('login-msg').textContent = '登录发起成功，请用微信扫码登录（更推荐）。';
  } else {
    $('login-msg').textContent = r.error || '登录发起失败';
  }
});

$('btn-captcha-refresh').addEventListener('click', async () => {
  const r = await api('/api/login/begin', { method: 'POST' });
  window._flow = r;
  if (r.captchaBase64) $('captcha-img').src = r.captchaBase64;
});

// 提交登录（含验证码）
$('captcha') && $('captcha').addEventListener('change', async () => {
  // 用户填完验证码后自动提交
  const code = $('captcha').value.trim();
  if (!code || !window._flow) return;
  $('login-msg').textContent = '正在登录...';
  const r = await api('/api/login/submit', {
    method: 'POST',
    body: JSON.stringify({
      username: $('username').value.trim(),
      password: $('password').value,
      lt: window._flow.lt,
      execution: window._flow.execution,
      captcha: code
    })
  });
  if (r.ok) {
    $('login-msg').textContent = '登录成功！';
    await refreshState();
  } else {
    $('login-msg').textContent = r.error || '登录失败';
  }
});

$('btn-wait-toggle').addEventListener('click', async () => {
  await api('/api/wait/start', { method: 'POST' });
  await refreshState();
});
$('btn-wait-stop').addEventListener('click', async () => {
  await api('/api/wait/stop', { method: 'POST' });
  await refreshState();
});

$('btn-course-reload').addEventListener('click', async () => {
  await api('/api/courses/reload', { method: 'POST' });
  await refreshState();
});

$('btn-submit-start').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('#course-list input[type=checkbox]:checked')].map((el) => el.value);
  if (!checked.length) {
    alert('请先勾选要抢的课程');
    return;
  }
  await api('/api/targets', { method: 'POST', body: JSON.stringify({ targets: checked }) });
  await api('/api/submit/start', { method: 'POST', body: JSON.stringify({ intervalMs: 800 }) });
  await refreshState();
});
$('btn-submit-stop').addEventListener('click', async () => {
  await api('/api/submit/stop', { method: 'POST' });
  await refreshState();
});

$('btn-about') && $('btn-about').addEventListener('click', () => $('modal-about').classList.remove('hidden'));
$('btn-about-close') && $('btn-about-close').addEventListener('click', () => $('modal-about').classList.add('hidden'));

// 定时刷新状态
setInterval(refreshState, 1500);
refreshState();
