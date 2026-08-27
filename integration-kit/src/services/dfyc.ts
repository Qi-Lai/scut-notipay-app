import { createFetch } from '../http';
import { defaultConfig, type ScutConfig } from '../config';
import type { DfycBills } from '../auth/dfyc';

interface DfycUserInfo {
  statusCode: string;
  resultObject: {
    realName?: string;
    roomId?: string;
    roomName?: string;
    loudongName?: string;
    schoolName?: string;
  };
}

/**
 * 用 dfyc 的 JSESSIONID 查用户信息（姓名 / 房间 / 楼栋 / 校区）。
 */
export const dfycUserInfo = async (
  jsessionid: string,
  config: ScutConfig = defaultConfig()
): Promise<DfycUserInfo['resultObject']> => {
  const fetchFn = createFetch(config.proxy);
  const res = await fetchFn(`${config.dfycBase}/sdms-weixin-pay-sp/service/find/userinfo`, {
    method: 'GET',
    headers: { Cookie: `JSESSIONID=${jsessionid}` }
  });
  if (!res.ok) throw new Error(`Get userInfo failed: HTTP ${res.status}`);
  const data = (await res.json()) as DfycUserInfo;
  if (data.statusCode !== '200') {
    throw new Error(`Get userInfo API Error: ${JSON.stringify(data)}`);
  }
  return data.resultObject;
};

interface DfycBalanceResponse {
  statusCode: string;
  message?: string;
  resultObject: { leftMoney?: number | string; leftEle?: number | string; leftFreeMoney?: number | string };
}

/**
 * 用 dfyc 的 JSESSIONID 查电表余额（-sp 版）。
 */
export const dfycElectricBalance = async (
  jsessionid: string,
  config: ScutConfig = defaultConfig()
): Promise<{ leftMoney: number; leftEle: number; elePrice: number }> => {
  const fetchFn = createFetch(config.proxy);
  const res = await fetchFn(`${config.dfycBase}/sdms-weixin-pay-sp/service/ammeterBalance?type=1`, {
    method: 'GET',
    headers: { Cookie: `JSESSIONID=${jsessionid}` }
  });
  if (!res.ok) throw new Error(`Get ammeterBalance failed: HTTP ${res.status}`);
  const data = (await res.json()) as DfycBalanceResponse &
    { resultObject: { elePrice?: number } };
  if (data.statusCode !== '200') {
    throw new Error(`Get ammeterBalance API Error: ${JSON.stringify(data)}`);
  }
  return {
    leftMoney: Number(data.resultObject.leftMoney ?? 0),
    leftEle: Number(data.resultObject.leftEle ?? 0),
    elePrice: Number(data.resultObject.elePrice ?? 0)
  };
};

/**
 * 用 dfyc 的 JSESSIONID 查水费余额（-sp 版）。
 */
export const dfycWaterBalance = async (
  jsessionid: string,
  config: ScutConfig = defaultConfig()
): Promise<{ leftWater: number; leftMoney: number }> => {
  const fetchFn = createFetch(config.proxy);
  const res = await fetchFn(
    `${config.dfycBase}/sdms-weixin-pay-sp/service/waterBalance?type=3&systemType=1`,
    {
      method: 'GET',
      headers: { Cookie: `JSESSIONID=${jsessionid}` }
    }
  );
  if (!res.ok) throw new Error(`Get waterBalance failed: HTTP ${res.status}`);
  const data = (await res.json()) as DfycBalanceResponse & {
    resultObject: { leftWater?: number | string };
  };
  if (data.statusCode !== '200') {
    throw new Error(`Get waterBalance API Error: ${JSON.stringify(data)}`);
  }
  return {
    leftWater: Number(data.resultObject.leftWater ?? 0),
    leftMoney: Number(data.resultObject.leftMoney ?? 0)
  };
};

/**
 * 一次性查电费 + 水费 + 用户信息，返回汇总。DXC 无空调费（ac=0）。
 */
export const dfycQueryBills = async (
  jsessionid: string,
  config: ScutConfig = defaultConfig()
): Promise<DfycBills & { room: string; user: DfycUserInfo['resultObject'] }> => {
  const [user, electric, water] = await Promise.all([
    dfycUserInfo(jsessionid, config),
    dfycElectricBalance(jsessionid, config),
    dfycWaterBalance(jsessionid, config)
  ]);
  return {
    electric: electric.leftMoney,
    water: water.leftMoney,
    ac: 0,
    room: user.roomName ?? '',
    user
  };
};
