import { ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';

/**
 * 创建带代理支持 + 手动重定向能力的 fetch。与一卡通/水电费系统对接时，
 * 登录链路需要 `redirect: 'manual'`（手动跟随 302 拿 Location / Set-Cookie），
 * 而标准的全局 fetch 会自动跟随。这里返回一个类型正确的 fetch 封装。
 *
 * @param proxy 可选代理地址，如 `socks5://127.0.0.1:7890` 或 `http://127.0.0.1:7892`。空则直连。
 */
export const createFetch = (proxy?: string) => {
  let dispatcher: unknown;

  if (proxy) {
    if (/^socks5?:\/\//i.test(proxy)) {
      const url = new URL(proxy);
      dispatcher = socksDispatcher({
        type: 5,
        host: url.hostname,
        port: parseInt(url.port) || 1080,
        ...(url.username && {
          userId: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password)
        })
      });
    } else {
      dispatcher = new ProxyAgent(proxy);
    }
  }

  const wrapped = async (
    input: string | URL | Request,
    init?: RequestInit & { dispatcher?: unknown }
  ): Promise<Response> => {
    if (dispatcher) {
      return globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
    }
    return globalThis.fetch(input, init as RequestInit);
  };

  // 显式标注支持 redirect:'manual'，与标准 fetch 的 RequestInit 类型对齐。
  return wrapped as typeof fetch;
};

/**
 * 提取响应 `Set-Cookie` 里指定名字的 cookie 值（第一个匹配）。
 * 用于从登录跳转的 302 响应里拿 JSESSIONID / TGC / locSession。
 */
export const extractCookie = (setCookieHeader: string | null, name: string): string => {
  if (!setCookieHeader) return '';
  // Set-Cookie 可能用逗号分隔多个，逐个找名字=值
  for (const part of setCookieHeader.split(',')) {
    const m = part.trim().match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return '';
};

/**
 * 把 `http:` 前缀换成 `https:`（登录跳转里 Location 有时给 http）。
 */
export const toHttps = (url: string | null): string | null => {
  if (!url) return null;
  return url.replace(/^http:/, 'https:');
};
