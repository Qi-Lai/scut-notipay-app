/**
 * 可注入配置。所有域名、凭证、代理都由这里传入，不硬编码锁死到具体学校，
 * 方便在别的环境 / 别的学校复用。默认值指向华南理工大学。
 */
export interface ScutConfig {
  /** 一卡通 OAuth 主站，默认 `https://ecardwxnew.scut.edu.cn` */
  cardBase: string;
  /** 水电费业务系统，默认 `https://dfyc.utc.scut.edu.cn` */
  dfycBase: string;
  /** 统一认证中心，默认 `https://sso.scut.edu.cn` */
  ssoBase: string;
  /**
   * 一卡通 OAuth 的 Basic 客户端凭证。
   * 默认是华工的一对值（Base64 = mobile_service_platform:mobile_service_platform_secret）。
   * 可覆盖（其他学校/环境）。
   */
  oauthClientBasic: string;
  /** 水电费登录跳转用到的 appId（一卡通侧的应用编号），默认 360 */
  dfycAppId: string;
  /** 水电费登录成功后期望跳转到的路径（-sp 版），用于校验登录是否成功 */
  dfycLoginSuccessPath: string;
  /** 可选网络代理，如 `socks5://127.0.0.1:7890` 或 `http://127.0.0.1:7892`。空 = 直连 */
  proxy: string;
}

export const defaultConfig = (overrides?: Partial<ScutConfig>): ScutConfig => ({
  cardBase: 'https://ecardwxnew.scut.edu.cn',
  dfycBase: 'https://dfyc.utc.scut.edu.cn',
  ssoBase: 'https://sso.scut.edu.cn',
  oauthClientBasic:
    'bW9iaWxlX3NlcnZpY2VfcGxhdGZvcm06bW9iaWxlX3NlcnZpY2VfcGxhdGZvcm1fc2VjcmV0',
  dfycAppId: '360',
  dfycLoginSuccessPath: '/sdms-weixin-pay-sp/newWeixin/index.html',
  proxy: '',
  ...(overrides || {})
});
