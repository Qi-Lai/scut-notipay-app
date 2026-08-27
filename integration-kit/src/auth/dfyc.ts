import { createFetch, extractCookie, toHttps } from '../http';
import { defaultConfig, type ScutConfig } from '../config';

export interface DfycLoginOptions {
  appId?: string;
  /** 登录成功后期望跳转到的路径，用于校验（-sp 版） */
  successPath?: string;
}

/**
 * 用一卡通 token + TGC + locSession 走水电费(-sp 版)的登录跳转链，拿到 wxPay 的 JSESSIONID。
 *
 * 链路（与 `getBillsDXC` 前 4 步一致）：
 *   redirect → thirdLogin → authorize → getCode → 校验跳转到 successPath
 *   期间从 thirdLogin 的 Set-Cookie 提取 JSESSIONID。
 */
export const dfycLogin = async (
  token: string,
  TGC: string,
  locSession: string,
  config: ScutConfig = defaultConfig(),
  options: DfycLoginOptions = {}
): Promise<string> => {
  const fetchFn = createFetch(config.proxy);
  const appId = options.appId ?? config.dfycAppId;
  const successPath = options.successPath ?? config.dfycLoginSuccessPath;
  let jsessionid = '';

  // 1) redirect（期望 302）
  let res = await fetchFn(
    `${config.cardBase}/berserker-base/redirect?appId=${appId}&loginFrom=h5&synAccessSource=h5&synjones-auth=${token}&type=app`,
    {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: `TGC=${TGC}; error_times=0; locSession=${locSession}` }
    }
  );
  if (res.status !== 302) throw new Error(`Get redirect failed: Expected 302, got ${res.status}`);
  const thirdLoginUrl = toHttps(res.headers.get('location'));
  if (!thirdLoginUrl) throw new Error('Get redirect: No redirect location found');

  // 2) thirdLogin（期望 302，从这里拿 JSESSIONID）
  res = await fetchFn(thirdLoginUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { Cookie: `TGC=${TGC}; locSession=${locSession}; error_times=0` }
  });
  const setCookie = res.headers.get('set-cookie');
  jsessionid = extractCookie(setCookie, 'JSESSIONID');
  if (!jsessionid) throw new Error('Get thirdLogin: Failed to get JSESSIONID cookie');
  if (res.status !== 302) throw new Error(`Get thirdLogin failed: Expected 302, got ${res.status}`);
  const authorizeUrl = toHttps(res.headers.get('location'));
  if (!authorizeUrl) throw new Error('Get thirdLogin: No redirect location found');

  // 3) authorize（期望 302）
  res = await fetchFn(authorizeUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { Cookie: `JSESSIONID=${jsessionid}; TGC=${TGC}; locSession=${locSession}; error_times=0` }
  });
  if (res.status !== 302) throw new Error(`Get authorize failed: Expected 302, got ${res.status}`);
  const getCodeUrl = toHttps(res.headers.get('location'));
  if (!getCodeUrl) throw new Error('Get authorize: No redirect location found');

  // 4) getCode（期望 302，且跳转目标等于 successPath）
  res = await fetchFn(getCodeUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { Cookie: `JSESSIONID=${jsessionid}; TGC=${TGC}; locSession=${locSession}; error_times=0` }
  });
  if (res.status !== 302) throw new Error(`Get getCode failed: Expected 302, got ${res.status}`);
  if (res.headers.get('location') !== successPath) {
    throw new Error(
      `Get getCode failed: Expected redirect to ${successPath}, got ${res.headers.get('location')}`
    );
  }

  return jsessionid;
};

/** 水费/电费余额查询结果 */
export interface DfycBills {
  electric: number;
  water: number;
  ac: number;
  room: string;
}
