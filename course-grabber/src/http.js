const { ProxyAgent } = require('undici');
const { socksDispatcher } = require('fetch-socks');

/**
 * 创建带代理 + 手动重定向能力的 fetch。教务登录链路需要 redirect:'manual' 来手动跟随 302。
 * @param {string} [proxy] 代理地址，如 socks5://127.0.0.1:7890 或 http://127.0.0.1:7892，空则直连
 */
function createFetch(proxy) {
  let dispatcher;
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
  return async (input, init) => {
    if (dispatcher) return globalThis.fetch(input, { ...init, dispatcher });
    return globalThis.fetch(input, init);
  };
}

/** 从 Set-Cookie 头提取指定 cookie 的值 */
function extractCookie(setCookieHeader, name) {
  if (!setCookieHeader) return '';
  for (const part of setCookieHeader.split(',')) {
    const m = part.trim().match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return '';
}

/** http: -> https: */
function toHttps(url) {
  if (!url) return null;
  return url.replace(/^http:/, 'https:');
}

module.exports = { createFetch, extractCookie, toHttps };
