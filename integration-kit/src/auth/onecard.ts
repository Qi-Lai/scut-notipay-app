import { createFetch, extractCookie } from '../http';
import { defaultConfig, type ScutConfig } from '../config';

export interface LoginResult {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token: string;
  name: string;
  sno: string;
  /** 从 Set-Cookie 提取的一卡通主站票据 */
  TGC: string;
  locSession: string;
}

/**
 * 一卡通登录前的「键盘加密」。
 * 先请求键盘表，再把密码每个数字映射到对应键盘字符，最后拼 `$1$<uuid>`。
 * 这是该校一卡通登录特有的密码变形步骤。
 */
const encryptPassword = async (
  password: string,
  cardBase: string,
  fetchFn: typeof fetch
): Promise<string> => {
  const res = await fetchFn(`${cardBase}/berserker-secure/keyboard?type=Standard&order=0&synAccessSource=h5`);
  const { data } = (await res.json()) as { data: { numberKeyboard: string; uuid: string } };
  const { numberKeyboard, uuid } = data;
  return (
    Array.from(password)
      .map((ch) => numberKeyboard.charAt(parseInt(ch, 10)))
      .join('') +
    '$1$' +
    uuid
  );
};

/**
 * 一卡通 OAuth 登录（学号 + 查询密码），返回 access_token / TGC / locSession。
 * 该 OAuth 端点本身不需要图形验证码（机器人可纯自动登录）。
 */
export const obtainToken = async (
  username: string,
  password: string,
  config: ScutConfig = defaultConfig()
): Promise<LoginResult | null> => {
  const fetchFn = createFetch(config.proxy);
  const encPassword = await encryptPassword(password, config.cardBase, fetchFn);

  const formData = new URLSearchParams();
  formData.append('username', username);
  formData.append('password', encPassword);
  formData.append('grant_type', 'password');
  formData.append('scope', 'all');
  formData.append('loginForm', 'h5');
  formData.append('logintype', 'card');
  formData.append('device_token', 'h5');
  formData.append('synAccessSource', 'h5');

  const res = await fetchFn(`${config.cardBase}/berserker-auth/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${config.oauthClientBasic}`
    },
    body: formData.toString()
  });

  const data = (await res.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token: string;
    name: string;
    sno: string;
  };

  if (!data.access_token) {
    // 打印学校服务器的原始拒绝原因（风控/验证码/密码错误等），便于诊断
    console.error('[onecard] OAuth raw:', JSON.stringify(data).slice(0, 400));
    return null;
  }

  const setCookie = res.headers.get('set-cookie') || '';
  const TGC = extractCookie(setCookie, 'TGC');
  const locSession = extractCookie(setCookie, 'locSession');

  return { ...data, TGC, locSession };
};
