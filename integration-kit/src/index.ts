/**
 * SCUT 校园网对接模块
 *
 * 对外统一出口。最小使用示例：
 *   const cfg = defaultConfig();
 *   const login = await obtainToken('学号', '查询密码', cfg);
 *   const jsessionid = await dfycLogin(login.access_token, login.TGC, login.locSession, cfg);
 *   const bills = await dfycQueryBills(jsessionid, cfg);
 */
export { defaultConfig, type ScutConfig } from './config';
export { createFetch, extractCookie, toHttps } from './http';
export { obtainToken, type LoginResult } from './auth/onecard';
export { dfycLogin, type DfycLoginOptions, type DfycBills } from './auth/dfyc';
export { dfycUserInfo, dfycElectricBalance, dfycWaterBalance, dfycQueryBills } from './services/dfyc';
