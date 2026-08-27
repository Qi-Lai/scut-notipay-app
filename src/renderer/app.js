/* global Chart */
/* eslint-disable no-undef */
'use strict';

const api = window.notipay;

// ---------------------------------------------------------------
// Toast
// ---------------------------------------------------------------
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ---------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------
const PAGE_REFRESHERS = {};

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    document.getElementById(`page-${page}`).classList.add('active');
    if (PAGE_REFRESHERS[page]) PAGE_REFRESHERS[page]();
  });
});

// ---------------------------------------------------------------
// Bot status
// ---------------------------------------------------------------
const STATE_TEXT = {
  stopped: '机器人已停止',
  connecting: '正在连接 NapCat…',
  online: '机器人在线',
  offline: '连接断开（重连中）'
};

function setBotState(state) {
  for (const dot of [document.getElementById('dash-status-dot'), document.getElementById('sidebar-status-dot')]) {
    dot.className = `status-dot ${state}${dot.id === 'dash-status-dot' ? ' large' : ''}`;
  }
  document.getElementById('dash-status-text').textContent = STATE_TEXT[state] || state;
  document.getElementById('sidebar-status-text').textContent = STATE_TEXT[state] || state;
}

function setNextRun(isoString) {
  const el = document.getElementById('stat-next-run');
  if (!isoString) {
    el.textContent = '—';
    return;
  }
  const d = new Date(isoString);
  el.textContent = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

// ---------------------------------------------------------------
// NapCat (one-click)
// ---------------------------------------------------------------
const NAPCAT_TEXT = {
  'not-found': '未检测到 NapCat',
  stopped: 'NapCat 已停止',
  running: 'NapCat 正在运行',
  'no-login': 'NapCat 待登录（首次使用）'
};

function setNapcatStatus(status, detail) {
  const dot = document.getElementById('napcat-status-dot');
  const statusClass =
    status === 'running' ? 'online' : status === 'no-login' ? 'connecting' : 'stopped';
  dot.className = `status-dot large ${statusClass}`;
  document.getElementById('napcat-status-text').textContent = NAPCAT_TEXT[status] || status;

  // Provide a helpful hint for the two states where the user must act.
  let hint = detail || '';
  if (status === 'no-login') {
    hint = detail || '点击「一键启动」后，在弹出的 QQ 窗口扫码登录（只需一次）';
  } else if (status === 'stopped') {
    hint = detail || '点击「一键启动」以开启 NapCat 并连接 QQ';
  }
  document.getElementById('napcat-status-detail').textContent = hint;

  // "一键启动" is enabled whenever NapCat is not already effective (running).
  // A running OS-level QQ.exe does NOT disable it — we may need to replace it
  // with the injected build, and the user should be able to trigger that.
  document.getElementById('btn-napcat-start').disabled = status === 'running';
  document.getElementById('btn-napcat-stop').disabled = status === 'not-found';
}

let napcatDetect = null;

async function refreshNapcat() {
  try {
    // Use the same status source as the live polling (status()), not the
    // detection snapshot, so the card reflects reality rather than "found".
    const [det, status] = await Promise.all([api.detectNapcat(), api.getNapcatStatus()]);
    napcatDetect = det;
    if (!det.found) {
      setNapcatStatus('not-found', '请安装 NapCat 或在设置指定目录');
      return;
    }
    const guide =
      status === 'no-login'
        ? '点击「一键启动」，然后在弹出的 QQ 窗口扫码登录（只需一次）'
        : status === 'stopped'
          ? '点击「一键启动」以开启 NapCat 并连接 QQ'
          : null;
    setNapcatStatus(status, guide ? `已找到：${det.dir}\n${guide}` : `已找到：${det.dir}`);
  } catch (e) {
    setNapcatStatus('not-found', e.message || String(e));
  }
}

async function handleNapcatStart() {
  const btn = document.getElementById('btn-napcat-start');
  btn.disabled = true;
  btn.textContent = '启动中…';
  try {
    await api.startNapcat({});
    toast('NapCat 启动指令已发送', 'success');
    setTimeout(refreshNapcat, 3500);
  } catch (e) {
    toast(`启动失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '一键启动 NapCat';
  }
}

async function handleNapcatStop() {
  try {
    await api.stopNapcat();
    toast('停止指令已发送', 'success');
    setTimeout(refreshNapcat, 1500);
  } catch (e) {
    toast(`停止失败：${e.message}`, 'error');
  }
}


// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------
async function refreshDashboard() {
  try {
    const state = await api.getAppState();
    setBotState(state.botState);
    setNextRun(state.nextRunAt);
    document.getElementById('stat-students').textContent = state.studentCount;
    document.getElementById('stat-notifications').textContent = state.notificationCount;
    document.getElementById('stat-records').textContent = state.recordCount;
    document.getElementById('dash-data-dir').textContent = state.dataDir;
    document.getElementById('sidebar-version').textContent = `v${state.version}`;

    const config = await api.getConfig();
    document.getElementById('dash-napcat-addr').textContent = `NapCat: ${config.napcatWs}`;
  } catch (error) {
    console.error(error);
  }
}
PAGE_REFRESHERS.dashboard = refreshDashboard;

document.getElementById('btn-napcat-start').addEventListener('click', handleNapcatStart);
document.getElementById('btn-napcat-stop').addEventListener('click', handleNapcatStop);
document.getElementById('btn-napcat-rescan').addEventListener('click', () => {
  refreshNapcat();
  toast('已重新检测', 'info');
});

document.getElementById('btn-bot-start').addEventListener('click', async () => {
  try {
    setBotState(await api.startBot());
    toast('已启动', 'success');
  } catch (e) {
    toast(`启动失败：${e.message}`, 'error');
  }
});

document.getElementById('btn-bot-stop').addEventListener('click', async () => {
  try {
    setBotState(await api.stopBot());
    toast('已停止', 'success');
  } catch (e) {
    toast(`停止失败：${e.message}`, 'error');
  }
});

document.getElementById('btn-bot-restart').addEventListener('click', async () => {
  try {
    setBotState(await api.restartBot());
    toast('已重启', 'success');
  } catch (e) {
    toast(`重启失败：${e.message}`, 'error');
  }
});

document.getElementById('btn-run-now').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '执行中…';
  try {
    await api.runNow();
    toast('整点任务执行完成', 'success');
    refreshDashboard();
  } catch (err) {
    toast(`执行失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '立即执行整点任务';
  }
});

document.getElementById('btn-open-data-dir').addEventListener('click', () => api.openDataDir());

// ---------------------------------------------------------------
// Students
// ---------------------------------------------------------------
let studentsCache = [];
let currentIntervalQq = null;
let pendingConfirm = null;

function fmtBalance(value) {
  if (value === null || value === undefined) return '—';
  const num = Number(value);
  const cls = num < 0 ? 'balance-neg' : num < 10 ? 'balance-low' : '';
  return `<span class="${cls}">${num.toFixed(2)}</span>`;
}

function fmtTime(iso) {
  if (!iso) return '从未';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

async function refreshStudents() {
  try {
    studentsCache = await api.listStudents();
    renderStudents();
  } catch (error) {
    console.error(error);
  }
}
PAGE_REFRESHERS.students = refreshStudents;

function renderStudents() {
  const tbody = document.getElementById('students-tbody');
  if (!studentsCache.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">暂无绑定用户，点击右上角「绑定用户」添加</td></tr>';
    return;
  }
  tbody.innerHTML = studentsCache
    .map((s) => {
      const b = s.latestBilling || {};
      return `<tr>
        <td>${escapeHtml(s.qq_id)}</td>
        <td>${escapeHtml(s.name || '—')}</td>
        <td>${escapeHtml(s.student_number || '—')}</td>
        <td>${escapeHtml(s.campus)}</td>
        <td>${escapeHtml(b.room || '—')}</td>
        <td>${fmtBalance(b.electric)}</td>
        <td>${fmtBalance(b.water)}</td>
        <td>${fmtBalance(b.ac)}</td>
        <td>${escapeHtml(s.fetch_interval || '1d')}</td>
        <td>${fmtTime(s.last_login)}</td>
        <td><div class="row-actions">
          <button class="btn small" data-action="query" data-qq="${s.qq_id}">查询</button>
          <button class="btn small" data-action="history" data-qq="${s.qq_id}">图表</button>
          <button class="btn small" data-action="interval" data-qq="${s.qq_id}">间隔</button>
          <button class="btn small danger" data-action="unbind" data-qq="${s.qq_id}">解绑</button>
        </div></td>
      </tr>`;
    })
    .join('');
}

document.getElementById('students-tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const qq = btn.dataset.qq;
  const action = btn.dataset.action;
  const student = studentsCache.find((s) => s.qq_id === qq);

  if (action === 'query') {
    btn.disabled = true;
    btn.textContent = '查询中';
    try {
      const result = await api.queryStudentNow(qq);
      const c = result.change24h;
      document.getElementById('query-result-body').innerHTML = `
        <div class="room">🏠 ${escapeHtml(result.room)}</div>
        <div>⚡ 电费：${result.electric.toFixed(2)} 元${c ? `（24h ${c.electric >= 0 ? '+' : ''}${c.electric.toFixed(2)}）` : ''}</div>
        <div>💧 水费：${result.water.toFixed(2)} 元${c ? `（24h ${c.water >= 0 ? '+' : ''}${c.water.toFixed(2)}）` : ''}</div>
        <div>❄️ 空调费：${result.ac.toFixed(2)} 元${c ? `（24h ${c.ac >= 0 ? '+' : ''}${c.ac.toFixed(2)}）` : ''}</div>`;
      openModal('modal-query');
    } catch (err) {
      toast(`查询失败：${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '查询';
    }
  } else if (action === 'history') {
    openHistoryModal(qq, student);
  } else if (action === 'interval') {
    // Electron disables window.prompt/confirm — use our own modal instead.
    currentIntervalQq = qq;
    const current = student?.fetch_interval || '1d';
    document.getElementById('interval-hint').textContent = `当前：${current}`;
    document.getElementById('interval-input').value = '';
    openModal('modal-interval');
  } else if (action === 'unbind') {
    const name = student?.name || qq;
    // Electron disables window.confirm — use the in-app confirm modal.
    confirmAction(
      `确定要解绑 ${name}（QQ: ${qq}）吗？\n该用户的凭据与通知计划将被删除。`,
      () => {
        void (async () => {
          try {
            await api.unbindStudent(qq);
            toast('已解绑', 'success');
            refreshStudents();
            refreshNotifications();
          } catch (err) {
            toast(`解绑失败：${err.message}`, 'error');
          }
        })();
      }
    );
  }
});

// Bind modal
document.getElementById('btn-add-student').addEventListener('click', () => {
  document.getElementById('bind-qq').value = '';
  document.getElementById('bind-card').value = '';
  document.getElementById('bind-password').value = '';
  document.getElementById('bind-interval').value = '1d';
  openModal('modal-bind');
});

document.getElementById('btn-bind-confirm').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const payload = {
    qqId: document.getElementById('bind-qq').value.trim(),
    cardId: document.getElementById('bind-card').value.trim(),
    password: document.getElementById('bind-password').value,
    campus: document.getElementById('bind-campus').value,
    interval: document.getElementById('bind-interval').value.trim() || '1d'
  };
  if (!payload.qqId || !payload.cardId || !payload.password) {
    toast('请填写完整信息', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = '登录验证中…';
  try {
    const result = await api.bindStudent(payload);
    closeModals();
    toast(`已绑定 ${result.name}（${result.sno}）`, 'success');
    refreshStudents();
    refreshDashboard();
  } catch (err) {
    toast(`绑定失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '验证并绑定';
  }
});

// History modal
let historyChart = null;
let historyQq = null;

function openHistoryModal(qq, student) {
  historyQq = qq;
  document.getElementById('history-title').textContent =
    `账单历史 — ${student?.name || qq}（${student?.latestBilling?.room || '未知宿舍'}）`;
  openModal('modal-history');
  loadHistoryChart();
}

document.getElementById('history-days').addEventListener('change', loadHistoryChart);

async function loadHistoryChart() {
  if (!historyQq) return;
  const days = parseInt(document.getElementById('history-days').value, 10);
  try {
    const history = await api.getStudentHistory(historyQq, days);
    const labels = history.map((h) => {
      const d = new Date(h.recorded_at.replace(' ', 'T'));
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:00`;
    });

    if (historyChart) {
      historyChart.destroy();
      historyChart = null;
    }

    if (history.length < 2) {
      toast('历史记录不足 2 条，无法绘制趋势图', 'error');
      return;
    }

    const ctx = document.getElementById('history-chart').getContext('2d');
    Chart.defaults.color = '#8b96ad';
    Chart.defaults.borderColor = 'rgba(38, 49, 73, 0.6)';
    historyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '电费 (¥)', data: history.map((h) => h.electric), borderColor: 'rgb(255, 99, 132)', backgroundColor: 'rgba(255, 99, 132, 0.08)', fill: true, tension: 0.3 },
          { label: '水费 (¥)', data: history.map((h) => h.water), borderColor: 'rgb(54, 162, 235)', backgroundColor: 'rgba(54, 162, 235, 0.08)', fill: true, tension: 0.3 },
          { label: '空调费 (¥)', data: history.map((h) => h.ac), borderColor: 'rgb(75, 192, 192)', backgroundColor: 'rgba(75, 192, 192, 0.08)', fill: true, tension: 0.3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top' } },
        scales: { y: { title: { display: true, text: '余额 (¥)' } } }
      }
    });
  } catch (err) {
    toast(`加载历史失败：${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------
let notificationsCache = [];

async function refreshNotifications() {
  try {
    notificationsCache = await api.listNotifications();
    renderNotifications();
  } catch (error) {
    console.error(error);
  }
}
PAGE_REFRESHERS.notifications = refreshNotifications;

function renderNotifications() {
  const tbody = document.getElementById('notifications-tbody');
  if (!notificationsCache.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无通知计划</td></tr>';
    return;
  }
  tbody.innerHTML = notificationsCache
    .map(
      (n) => `<tr>
        <td>${escapeHtml(n.qq_id)}</td>
        <td>${escapeHtml(n.studentName || '—')}</td>
        <td>${n.chat_type === 'private' ? '私聊' : '群聊'} ${escapeHtml(n.chat_id)}</td>
        <td>每天 ${String(n.hour).padStart(2, '0')}:00</td>
        <td>${n.threshold !== null && n.threshold !== undefined ? `低于 ${n.threshold} 元` : '总是推送'}</td>
        <td>${escapeHtml((n.lines || 'ewa').toUpperCase())}</td>
        <td>${fmtTime(n.updated_at)}</td>
        <td><button class="btn small danger" data-del data-ct="${n.chat_type}" data-cid="${escapeHtml(n.chat_id)}" data-qq="${n.qq_id}">删除</button></td>
      </tr>`
    )
    .join('');
}

document.getElementById('notifications-tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-del]');
  if (!btn) return;
  confirmAction('确定删除该通知计划吗？', () => {
    void (async () => {
      try {
        await api.deleteNotification(btn.dataset.ct, btn.dataset.cid, btn.dataset.qq);
        toast('已删除', 'success');
        refreshNotifications();
        refreshDashboard();
      } catch (err) {
        toast(`删除失败：${err.message}`, 'error');
      }
    })();
  });
});

document.getElementById('btn-add-notification').addEventListener('click', async () => {
  if (!studentsCache.length) {
    await refreshStudents();
  }
  const select = document.getElementById('notify-qq');
  if (!studentsCache.length) {
    toast('请先在「用户管理」绑定用户', 'error');
    return;
  }
  select.innerHTML = studentsCache
    .map((s) => `<option value="${s.qq_id}">${escapeHtml(s.name || '')}（${s.qq_id}）</option>`)
    .join('');
  const first = studentsCache[0];
  document.getElementById('notify-chat-id').value = first.qq_id;
  openModal('modal-notification');
});

document.getElementById('notify-chat-type').addEventListener('change', (e) => {
  // Default chat id: private → QQ itself; group → clear for manual input
  const qq = document.getElementById('notify-qq').value;
  document.getElementById('notify-chat-id').value = e.target.value === 'private' ? qq : '';
});

document.getElementById('notify-qq').addEventListener('change', (e) => {
  if (document.getElementById('notify-chat-type').value === 'private') {
    document.getElementById('notify-chat-id').value = e.target.value;
  }
});

document.getElementById('btn-notify-confirm').addEventListener('click', async () => {
  const lines =
    (document.getElementById('notify-line-e').checked ? 'e' : '') +
    (document.getElementById('notify-line-w').checked ? 'w' : '') +
    (document.getElementById('notify-line-a').checked ? 'a' : '');
  if (!lines) {
    toast('请至少选择一个通知项目', 'error');
    return;
  }
  const thresholdRaw = document.getElementById('notify-threshold').value;
  const payload = {
    qqId: document.getElementById('notify-qq').value,
    chatType: document.getElementById('notify-chat-type').value,
    chatId: document.getElementById('notify-chat-id').value.trim(),
    hour: parseInt(document.getElementById('notify-hour').value, 10),
    threshold: thresholdRaw === '' ? null : parseFloat(thresholdRaw),
    lines
  };
  if (!payload.chatId) {
    toast('请填写目标 ID', 'error');
    return;
  }
  if (isNaN(payload.hour) || payload.hour < 0 || payload.hour > 23) {
    toast('小时必须是 0-23', 'error');
    return;
  }
  try {
    await api.addNotification(payload);
    closeModals();
    toast('通知计划已保存', 'success');
    refreshNotifications();
    refreshDashboard();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
});

// ---------------------------------------------------------------
// Logs
// ---------------------------------------------------------------
const logView = document.getElementById('log-view');
let logPaused = false;
const MAX_LOG_LINES = 800;

function appendLog(entry) {
  const levelFilter = document.getElementById('log-level-filter').value;
  const line = document.createElement('div');
  line.className = 'log-line';
  line.dataset.level = entry.level;
  const time = new Date(entry.time);
  const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
  line.innerHTML = `<span class="log-time">${timeStr}</span><span class="log-level ${entry.level}">${entry.level.toUpperCase()}</span><span class="log-text">${escapeHtml(entry.text)}</span>`;
  if (levelFilter !== 'all' && entry.level !== levelFilter) {
    line.style.display = 'none';
  }
  logView.appendChild(line);
  while (logView.children.length > MAX_LOG_LINES) {
    logView.removeChild(logView.firstChild);
  }
  if (!logPaused) {
    logView.scrollTop = logView.scrollHeight;
  }
}

async function loadLogs() {
  const logs = await api.getLogs();
  logView.innerHTML = '';
  logs.forEach(appendLog);
}
PAGE_REFRESHERS.logs = loadLogs;

document.getElementById('btn-log-pause').addEventListener('click', (e) => {
  logPaused = !logPaused;
  e.currentTarget.textContent = logPaused ? '恢复滚动' : '暂停滚动';
});

document.getElementById('btn-log-clear').addEventListener('click', () => {
  logView.innerHTML = '';
});

document.getElementById('log-level-filter').addEventListener('change', (e) => {
  const level = e.target.value;
  logView.querySelectorAll('.log-line').forEach((line) => {
    line.style.display = level === 'all' || line.dataset.level === level ? '' : 'none';
  });
});

// ---------------------------------------------------------------
// Settings
// ---------------------------------------------------------------
async function loadSettings() {
  try {
    const config = await api.getConfig();
    document.getElementById('cfg-napcat-dir').value = config.napcatDir || '';
    document.getElementById('cfg-napcat-ws').value = config.napcatWs || '';
    document.getElementById('cfg-napcat-token').value = config.napcatToken || '';
    document.getElementById('cfg-command-names').value = (config.commandNames || []).join(',');
    document.getElementById('cfg-retry-count').value = config.billingRetryCount ?? 3;
    document.getElementById('cfg-proxy').value = config.proxy || '';
    document.getElementById('cfg-auto-start').checked = !!config.autoStart;

    await loadDataLocation();
  } catch (error) {
    console.error(error);
  }
}
PAGE_REFRESHERS.settings = loadSettings;

async function loadDataLocation() {
  try {
    const loc = await api.getDataLocation();
    document.getElementById('data-dir-path').textContent = loc.currentDir;
    const hint = document.getElementById('data-dir-hint');
    if (loc.custom) {
      hint.textContent = '当前为自定义位置。可更改到其它磁盘，更改时会自动迁移现有数据。';
    } else {
      hint.textContent = '默认位置在系统盘（AppData）。如需释放 C 盘空间或方便备份，可更改到其它磁盘。';
    }
  } catch (e) {
    document.getElementById('data-dir-path').textContent = '读取失败';
  }
}

document.getElementById('btn-open-data').addEventListener('click', () => api.openDataDir());

document.getElementById('btn-migrate-data').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '迁移中…';
  try {
    const result = await api.chooseAndMigrateData();
    if (result.canceled) {
      btn.disabled = false;
      btn.textContent = '更改存储位置…';
      return;
    }
    if (result.changed) {
      toast('数据已迁移，正在重启应用…', 'success');
      setTimeout(() => api.relaunchApp(), 600);
      return;
    }
    // Not changed (same dir or failure)
    toast(result.message || '未发生更改', result.changed === false && result.message ? 'error' : 'info');
    btn.disabled = false;
    btn.textContent = '更改存储位置…';
  } catch (err) {
    toast(`迁移失败：${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = '更改存储位置…';
  }
});

document.getElementById('btn-save-config').addEventListener('click', async () => {
  const commandNames = document
    .getElementById('cfg-command-names')
    .value.split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const patch = {
    napcatDir: document.getElementById('cfg-napcat-dir').value.trim(),
    napcatWs: document.getElementById('cfg-napcat-ws').value.trim(),
    napcatToken: document.getElementById('cfg-napcat-token').value.trim(),
    commandNames: commandNames.length ? commandNames : ['scut-notipay', 'snp'],
    billingRetryCount: Math.max(0, parseInt(document.getElementById('cfg-retry-count').value, 10) || 0),
    proxy: document.getElementById('cfg-proxy').value.trim(),
    autoStart: document.getElementById('cfg-auto-start').checked
  };
  if (patch.napcatWs && !/^wss?:\/\//.test(patch.napcatWs)) {
    toast('WebSocket 地址应以 ws:// 或 wss:// 开头', 'error');
    return;
  }
  if (patch.proxy && !/^(https?|socks5?):\/\//.test(patch.proxy)) {
    toast('代理地址应以 http:// 或 socks5:// 开头', 'error');
    return;
  }
  try {
    await api.updateConfig(patch);
    toast('设置已保存', 'success');
    refreshDashboard();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
});

// ---------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModals() {
  document.querySelectorAll('.modal-mask').forEach((m) => m.classList.add('hidden'));
}

document.querySelectorAll('.modal-mask').forEach((mask) => {
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.classList.add('hidden');
  });
  mask.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => mask.classList.add('hidden'));
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModals();
});

// Confirm "set interval" from the modal (replaces Electron-disabled prompt).
document.getElementById('btn-interval-confirm').addEventListener('click', async () => {
  if (!currentIntervalQq) {
    closeModals();
    return;
  }
  const input = document.getElementById('interval-input').value.trim();
  if (!input) {
    document.getElementById('interval-input').focus();
    return;
  }
  try {
    await api.setStudentInterval(currentIntervalQq, input);
    toast('更新间隔已修改', 'success');
    refreshStudents();
    closeModals();
  } catch (err) {
    toast(`修改失败：${err.message}`, 'error');
  }
});

// Generic confirm dialog (Electron disables the native window.confirm).
function confirmAction(message, onYes) {
  document.getElementById('confirm-body').textContent = message;
  pendingConfirm = onYes;
  openModal('modal-confirm');
}

document.getElementById('btn-confirm-yes').addEventListener('click', () => {
  const fn = pendingConfirm;
  pendingConfirm = null;
  closeModals();
  if (fn) fn();
});

// ---------------------------------------------------------------
// Realtime events from main process
// ---------------------------------------------------------------
api.onBotState((state) => {
  setBotState(state);
});
api.onSchedule((nextRunAt) => {
  setNextRun(nextRunAt);
});
api.onLog((entry) => {
  appendLog(entry);
});
api.onStudentsChanged(() => {
  refreshStudents();
  refreshDashboard();
});
api.onNotificationsChanged(() => {
  refreshNotifications();
  refreshDashboard();
});
api.onHourlyComplete(() => {
  refreshDashboard();
  refreshStudents();
});
api.onNapcatStatus((status) => {
  setNapcatStatus(status, napcatDetect && napcatDetect.found ? `已找到：${napcatDetect.dir}` : '');
});
api.onNapcatQrcode(() => {
  toast('登录二维码已自动打开，请用手机 QQ 扫码', 'success');
});

// ---------------------------------------------------------------
// Theme toggle (light / dark)
// ---------------------------------------------------------------
const THEME_KEY = 'scut-notipay-theme';

function applyTheme(theme) {
  const isLight = theme === 'light';
  document.body.setAttribute('data-theme', isLight ? 'light' : 'dark');
  document.getElementById('theme-toggle-icon').textContent = isLight ? '🌙' : '☀️';
  document.getElementById('theme-toggle-text').textContent = isLight ? '深色模式' : '浅色模式';
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

function initTheme() {
  let theme = 'dark';
  try {
    theme = localStorage.getItem(THEME_KEY) || 'dark';
  } catch {
    // ignore
  }
  applyTheme(theme);
}

document.getElementById('btn-theme-toggle').addEventListener('click', () => {
  const current = document.body.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(current === 'light' ? 'dark' : 'light');
});

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
(async () => {
  initTheme();
  await refreshDashboard();
  await loadLogs();
  refreshStudents();
  refreshNotifications();
  loadSettings();
  refreshNapcat();
})();
