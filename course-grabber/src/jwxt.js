const { createFetch } = require('./http');

const JW_BASE = 'http://jw2018.jw.scut.edu.cn';

/**
 * 带 JSESSIONID cookie 的教务请求封装。
 */
function jwFetch(jsessionid, path, init, config) {
  const fetchFn = createFetch(config.proxy);
  const headers = {
    Cookie: `JSESSIONID=${jsessionid}`,
    'X-Requested-With': 'XMLHttpRequest',
    ...(init && init.headers)
  };
  return fetchFn(`${JW_BASE}${path}`, { ...init, headers });
}

/**
 * 查课程列表（自主选课-预选）。返回正方标准分页 JSON。
 * 关键：data.totalResult > 0 表示选课已开放、有课程。
 */
async function queryCourses(jsessionid, config, params = {}) {
  const qs = new URLSearchParams({
    jgpxzd: '1',
    ...params
  }).toString();
  const res = await jwFetch(jsessionid, `/jwglxt/xsxk/zzxkyzb_cxZzxkYzb.html?${qs}`, {}, config);
  if (!res.ok) throw new Error(`查询课程失败 HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`查询课程返回非JSON: ${text.slice(0, 100)}`);
  }
}

/**
 * 查课程详情（含余量、教学班号等，用于提交前确认）。
 */
async function queryCourseDetail(jsessionid, config, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await jwFetch(jsessionid, `/jwglxt/xsxk/zzxkyzb_cxZzxkYzbXx.html?${qs}`, {}, config);
  if (!res.ok) throw new Error(`查询课程详情失败 HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

/**
 * 提交选课（POST）。body 用 xklxbm（选课类别编码）等形式，参数选课后实测校准。
 * 返回 { ok:boolean, message:string, data? }。
 */
async function submitCourse(jsessionid, config, courseParams) {
  // courseParams 含教学班号(kch/kcm 等) + 选课类别，提交到 xkxk
  const body = new URLSearchParams(courseParams);
  const res = await jwFetch(
    jsessionid,
    '/jwglxt/xsxk/zzxkyzb_xkxk.html',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    },
    config
  );
  if (!res.ok) throw new Error(`提交选课失败 HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`提交选课返回非JSON: ${text.slice(0, 100)}`);
  }
  // 正方提交通常返回 { queryModel, itemList:[{xxkxx....}] } 或 message
  const success = data && (data.statusCode === undefined || Number(data.statusCode) === 200);
  return { ok: success, message: data && (data.message || '已提交'), data };
}

module.exports = { queryCourses, queryCourseDetail, submitCourse, JW_BASE };
