/**
 * 内存状态存储。所有运行时状态（会话、课程、目标、提交任务）只存本机内存，不落盘。
 */
const state = {
  phase: 'CONFIG', // CONFIG | LOGIN | WAIT | LIST | SUBMIT | DONE | STOP
  config: {
    username: '',
    password: '',
    proxy: '',
    jwBase: 'http://jw2018.jw.scut.edu.cn',
    ssoBase: 'https://sso.scut.edu.cn'
  },
  login: {
    inProgress: false,
    lt: '',
    execution: '',
    captchaBase64: '',
    jsessionid: ''
  },
  // 选课轮询状态
  wait: {
    running: false,
    timer: null,
    lastCourseCount: 0,
    lastCheckAt: 0,
    log: []
  },
  // 课程名单（解析后的列表）
  courses: [],
  // 你勾选的目标课
  targets: [],
  // 提交任务状态 map：kch -> {status, attempts, lastError}
  submitStatus: {},
  submitRunning: false,
  submitTimer: null
};

function get() {
  return state;
}

function setPhase(phase) {
  state.phase = phase;
}

function setConfig(patch) {
  Object.assign(state.config, patch);
}

function setLogin(patch) {
  Object.assign(state.login, patch);
}

function setCourses(courses) {
  state.courses = courses;
}

function setTargets(targets) {
  state.targets = targets;
}

function setSubmitStatus(kch, patch) {
  state.submitStatus[kch] = { ...(state.submitStatus[kch] || {}), ...patch };
}

function setSubmitRunning(v) {
  state.submitRunning = v;
}

function clearSubmitStatus() {
  state.submitStatus = {};
}

function addLog(level, msg) {
  state.wait.log.push({ level, msg, t: Date.now() });
  if (state.wait.log.length > 200) state.wait.log.splice(0, state.wait.log.length - 200);
}

module.exports = {
  get,
  setPhase,
  setConfig,
  setLogin,
  setCourses,
  setTargets,
  setSubmitStatus,
  setSubmitRunning,
  clearSubmitStatus,
  addLog
};
