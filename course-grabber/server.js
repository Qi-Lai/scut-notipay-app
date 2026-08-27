const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./src/store');
const service = require('./src/service');

const PORT = 8787;
const PUBLIC = path.join(__dirname, 'public');

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};

async function handleApi(req, res, url, body) {
  const p = url.pathname;
  const json = (o) => send(res, 200, o);

  try {
    if (p === '/api/config' && req.method === 'POST') {
      store.setConfig(body);
      return json({ ok: true });
    }
    if (p === '/api/login/begin') {
      const r = await service.beginLogin();
      return json({ ok: true, ...r });
    }
    if (p === '/api/login/submit') {
      const r = await service.submitLogin(body);
      return json({ ok: true, ...r });
    }
    if (p === '/api/login/scan') {
      const r = await service.startQrLogin();
      return json({ ok: true, ...r });
    }
    if (p === '/api/login/scan-poll') {
      const r = await service.pollQrLogin();
      return json({ ok: true, ...r });
    }
    if (p === '/api/wait/start') {
      await service.startWait();
      return json({ ok: true });
    }
    if (p === '/api/wait/stop') {
      service.stopWait();
      return json({ ok: true });
    }
    if (p === '/api/state') {
      const s = store.get();
      return json({
        phase: s.phase,
        login: { lt: s.login.lt, execution: s.login.execution, captchaBase64: s.login.captchaBase64, jsessionid: !!s.login.jsessionid },
        wait: { running: s.wait.running, lastCourseCount: s.wait.lastCourseCount, lastCheckAt: s.wait.lastCheckAt, log: s.wait.log.slice(-80) },
        courses: s.courses,
        targets: s.targets,
        submitStatus: s.submitStatus,
        submitRunning: s.submitRunning,
        config: { username: s.config.username, proxy: s.config.proxy }
      });
    }
    if (p === '/api/courses/reload') {
      const r = await service.loadCourses();
      return json({ ok: true, count: r.length });
    }
    if (p === '/api/targets' && req.method === 'POST') {
      store.setTargets(body.targets || []);
      return json({ ok: true });
    }
    if (p === '/api/submit/start') {
      await service.startSubmit(body.intervalMs || 800);
      return json({ ok: true });
    }
    if (p === '/api/submit/stop') {
      service.stopSubmit();
      return json({ ok: true });
    }
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }

  return send(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 静态文件（前端）
  const filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC)) {
    return send(res, 403, { ok: false, error: 'forbidden' });
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
    return fs.createReadStream(filePath).pipe(res);
  }

  // API（需要读 body）
  if (url.pathname.startsWith('/api/')) {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', async () => {
      let body = {};
      if (chunks) {
        try {
          body = JSON.parse(chunks);
        } catch (e) {
          body = {};
        }
      }
      await handleApi(req, res, url, body);
    });
    return;
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`  [scut-course-grabber] 服务已启动`);
  console.log(`  打开浏览器访问: http://127.0.0.1:${PORT}`);
});
