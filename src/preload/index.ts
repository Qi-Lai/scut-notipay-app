import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

type Unsubscribe = () => void;

const on = (channel: string, callback: (payload: unknown) => void): Unsubscribe => {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => callback(args[0]);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const onVoid = (channel: string, callback: () => void): Unsubscribe => {
  const listener = (): void => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  // App
  getAppState: () => invoke('app:getState'),
  openDataDir: () => invoke('app:openDataDir'),
  getLogs: () => invoke('logs:get'),

  // Data location
  getDataLocation: () => invoke('data:getLocation'),
  chooseAndMigrateData: () => invoke('data:chooseAndMigrate'),
  relaunchApp: () => invoke('app:relaunch'),

  // Config
  getConfig: () => invoke('config:get'),
  updateConfig: (patch: Record<string, unknown>) => invoke('config:update', patch),

  // Bot lifecycle
  startBot: () => invoke('bot:start'),
  stopBot: () => invoke('bot:stop'),
  restartBot: () => invoke('bot:restart'),
  runNow: () => invoke('bot:runNow'),

  // Students
  listStudents: () => invoke('students:list'),
  bindStudent: (payload: {
    qqId: string;
    cardId: string;
    password: string;
    campus: string;
    interval?: string;
  }) => invoke('students:bind', payload),
  unbindStudent: (qqId: string) => invoke('students:unbind', qqId),
  queryStudentNow: (qqId: string) => invoke('students:queryNow', qqId),
  getStudentHistory: (qqId: string, days?: number) => invoke('students:history', qqId, days),
  setStudentInterval: (qqId: string, interval: string) =>
    invoke('students:setInterval', qqId, interval),

  // Notifications
  listNotifications: () => invoke('notifications:list'),
  addNotification: (payload: {
    chatType: 'private' | 'group';
    chatId: string;
    qqId: string;
    hour: number;
    threshold?: number | null;
    lines?: string;
  }) => invoke('notifications:add', payload),
  deleteNotification: (chatType: string, chatId: string, qqId: string) =>
    invoke('notifications:delete', chatType, chatId, qqId),

  // NapCat management
  detectNapcat: (dir?: string) => invoke('napcat:detect', dir),
  getNapcatStatus: () => invoke('napcat:status'),
  startNapcat: (payload: { dir?: string; uin?: string }) => invoke('napcat:start', payload),
  stopNapcat: () => invoke('napcat:stop'),
  refreshNapcatAccounts: () => invoke('napcat:refreshAccounts'),
  configureNapcat: (uin: string, port?: number, token?: string) =>
    invoke('napcat:configure', uin, port, token),

  // Events (each returns an unsubscribe function)
  onLog: (callback: (entry: unknown) => void) => on('log', callback),
  onBotState: (callback: (state: unknown) => void) => on('bot-state', callback),
  onSchedule: (callback: (nextRunAt: unknown) => void) => on('schedule', callback),
  onStudentsChanged: (callback: () => void) => onVoid('students-changed', callback),
  onNotificationsChanged: (callback: () => void) => onVoid('notifications-changed', callback),
  onHourlyComplete: (callback: () => void) => onVoid('hourly-complete', callback),
  onNapcatStatus: (callback: (status: unknown) => void) => on('napcat-status', callback),
  onNapcatQrcode: (callback: (imagePath: unknown) => void) => on('napcat-qrcode', callback)
};

contextBridge.exposeInMainWorld('notipay', api);
