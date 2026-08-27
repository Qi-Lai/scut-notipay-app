import { app, ipcMain, shell, BrowserWindow, dialog } from 'electron';
import { Bot } from '../core/bot';
import { getConfigStore, getConfig, type AppConfig } from '../core/config';
import { getDb, getScheduler, closeDatabase } from '../core/database';
import { obtainToken as login } from '../core/session';
import { getLogBuffer } from './logger';
import { CAMPUSES } from '../core/constants';
import { parseRelativeTime } from '../core/timeparse';
import type { Campus } from '../core/database';
import { napcatManager, type NapCatStatus } from '../core/napcat-manager';
import { getDataDir, migrateDataDir, hasCustomDataDir, defaultDataDir } from '../core/data-location';

interface IpcContext {
  getBot: () => Bot;
  restartBot: () => Promise<void>;
  getNapcatDir: () => string | null;
  setNapcatDir: (dir: string | null) => void;
}

const broadcast = (channel: string, payload?: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

export const registerIpcHandlers = (ctx: IpcContext): void => {
  // ---------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------
  ipcMain.handle('app:getState', () => {
    const db = getDb();
    const scheduler = getScheduler();
    const bot = ctx.getBot();
    const recordCount = db
      .getDatabase()
      .prepare('SELECT COUNT(*) as count FROM billing_history')
      .get() as { count: number };
    return {
      botState: bot.getState(),
      nextRunAt: bot.getNextRunAt()?.toISOString() ?? null,
      studentCount: db.getStudentCount(),
      notificationCount: scheduler.getNotificationCount(),
      recordCount: recordCount.count,
      version: app.getVersion(),
      dataDir: getDataDir()
    };
  });

  ipcMain.handle('app:openDataDir', async () => {
    await shell.openPath(getDataDir());
  });

  ipcMain.handle('data:getLocation', () => {
    return {
      currentDir: getDataDir(),
      defaultDir: defaultDataDir(),
      custom: hasCustomDataDir()
    };
  });

  ipcMain.handle('data:chooseAndMigrate', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择新的数据存储位置',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || filePaths.length === 0) {
      return { canceled: true };
    }
    const targetDir = filePaths[0];
    if (targetDir === getDataDir()) {
      return { canceled: false, changed: false, message: '已选择相同目录，无需迁移。' };
    }
    // Close the DB so its file isn't locked, then copy data to the new dir.
    closeDatabase();
    try {
      const newDir = migrateDataDir(targetDir);
      return { canceled: false, changed: true, newDir };
    } catch (err) {
      return { canceled: false, changed: false, message: `迁移失败：${err instanceof Error ? err.message : String(err)}` };
    }
  });

  ipcMain.handle('app:relaunch', () => {
    // Relaunch so the DB/config reload from the (possibly migrated) data dir.
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('logs:get', () => getLogBuffer());

  // ---------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------
  ipcMain.handle('config:get', () => {
    const config = getConfig();
    // Never hand the encryption key to the UI
    return { ...config, encryptionKey: '********' };
  });

  ipcMain.handle('config:update', async (_event, patch: Partial<AppConfig>) => {
    const store = getConfigStore();
    const before = getConfig();
    const cleanPatch = { ...patch };
    if (cleanPatch.encryptionKey === '********') {
      delete cleanPatch.encryptionKey;
    }
    const next = store.update(cleanPatch);
    store.applyProxy();

    // Restart the bot if connection-related settings changed while running
    const bot = ctx.getBot();
    const connectionChanged =
      before.napcatWs !== next.napcatWs || before.napcatToken !== next.napcatToken;
    if (connectionChanged && bot.getState() !== 'stopped') {
      await ctx.restartBot();
    }

    return { ...store.get(), encryptionKey: '********' };
  });

  // ---------------------------------------------------------------
  // Bot lifecycle
  // ---------------------------------------------------------------
  ipcMain.handle('bot:start', async () => {
    await ctx.getBot().start();
    return ctx.getBot().getState();
  });

  ipcMain.handle('bot:stop', async () => {
    await ctx.getBot().stop();
    return ctx.getBot().getState();
  });

  ipcMain.handle('bot:restart', async () => {
    await ctx.restartBot();
    return ctx.getBot().getState();
  });

  ipcMain.handle('bot:runNow', async () => {
    await ctx.getBot().runHourlyTasks();
    return true;
  });

  // ---------------------------------------------------------------
  // Students
  // ---------------------------------------------------------------
  ipcMain.handle('students:list', () => {
    const db = getDb();
    return db.getAllStudents().map((student) => ({
      ...student,
      latestBilling: db.getLatestBilling(student.qq_id)
    }));
  });

  ipcMain.handle(
    'students:bind',
    async (
      _event,
      payload: {
        qqId: string;
        cardId: string;
        password: string;
        campus: string;
        interval?: string;
      }
    ) => {
      const { qqId, cardId, password, interval } = payload;
      const campus = payload.campus.toUpperCase();

      if (!/^\d{4,12}$/.test(qqId)) {
        throw new Error('QQ 号格式不正确');
      }
      if (!cardId || !password) {
        throw new Error('卡号和密码不能为空');
      }
      if (!CAMPUSES.includes(campus as Campus)) {
        throw new Error('校区必须是 GZIC 或 DXC');
      }

      let fetchInterval = '1d';
      if (interval) {
        const hours = parseRelativeTime(interval);
        if (hours < 1) throw new Error('更新间隔不能小于 1 小时');
        fetchInterval = interval;
      }

      console.log(`[Bind] UI bind request: QQ ${qqId}, Card ID ${cardId}`);
      const result = await login(cardId, password);
      if (!result) {
        throw new Error('登录失败，请检查卡号和密码是否正确');
      }

      const db = getDb();
      db.addStudent(
        qqId,
        cardId,
        campus as Campus,
        password,
        result.name,
        result.sno,
        fetchInterval
      );
      db.updateTokens(qqId, result.access_token, result.TGC, result.locSession, result.expires_in);
      console.log(`[DB] Stored credentials and token for ${result.name} (${result.sno})`);
      broadcast('students-changed');
      return { name: result.name, sno: result.sno };
    }
  );

  ipcMain.handle('students:unbind', (_event, qqId: string) => {
    const db = getDb();
    db.clearAccessToken(qqId);
    const deleted = db.deleteStudent(qqId);
    broadcast('students-changed');
    return deleted;
  });

  ipcMain.handle('students:queryNow', async (_event, qqId: string) => {
    const bot = ctx.getBot();
    const db = getDb();
    const bills = await bot.fetchBillsForUser(qqId);
    const change24h = db.getBilling24HourChange(qqId);
    broadcast('students-changed');
    return { ...bills, change24h };
  });

  ipcMain.handle('students:history', (_event, qqId: string, days?: number) => {
    const db = getDb();
    const history = db.getBillingHistory(qqId, days ?? 30);
    return history.reverse();
  });

  ipcMain.handle('students:setInterval', (_event, qqId: string, interval: string) => {
    const hours = parseRelativeTime(interval);
    if (hours < 1) throw new Error('更新间隔不能小于 1 小时');
    getDb().updateFetchInterval(qqId, interval);
    broadcast('students-changed');
    return true;
  });

  // ---------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------
  ipcMain.handle('notifications:list', () => {
    const scheduler = getScheduler();
    const db = getDb();
    return scheduler.getAllNotifications().map((notification) => {
      const student = db.getStudent(notification.qq_id);
      return { ...notification, studentName: student?.name ?? null };
    });
  });

  ipcMain.handle(
    'notifications:add',
    (
      _event,
      payload: {
        chatType: 'private' | 'group';
        chatId: string;
        qqId: string;
        hour: number;
        threshold?: number | null;
        lines?: string;
      }
    ) => {
      const scheduler = getScheduler();
      const notification = scheduler.setNotification(
        payload.chatType,
        payload.chatId,
        payload.qqId,
        payload.hour,
        payload.threshold ?? undefined,
        payload.lines || 'ewa'
      );
      broadcast('notifications-changed');
      return notification;
    }
  );

  ipcMain.handle(
    'notifications:delete',
    (_event, chatType: 'private' | 'group', chatId: string, qqId: string) => {
      const deleted = getScheduler().deleteNotification(chatType, chatId, qqId);
      broadcast('notifications-changed');
      return deleted;
    }
  );

  // ---------------------------------------------------------------
  // NapCat management (one-click bring-up)
  // ---------------------------------------------------------------
  ipcMain.handle('napcat:detect', async (_event, dirHint?: string) => {
    const result = await napcatManager.detect(dirHint ?? ctx.getNapcatDir() ?? undefined);
    // If we found a known install dir, remember it for next time.
    if (result.found && result.dir) ctx.setNapcatDir(result.dir);
    if (!result.found && dirHint) ctx.setNapcatDir(dirHint);
    return result;
  });

  ipcMain.handle('napcat:status', async () => {
    const status: NapCatStatus = await napcatManager.status();
    return status;
  });

  ipcMain.handle(
    'napcat:start',
    async (
      _event,
      payload: { dir?: string; uin?: string; autoConfigure?: boolean }
    ) => {
      let det = await napcatManager.detect(payload.dir ?? ctx.getNapcatDir() ?? undefined);
      if (!det.found) {
        throw new Error('未找到 NapCat 安装，请先安装或指定目录');
      }

      const port = napcatManager.getConfiguredPort();
      const token = getConfig().napcatToken;

      // Automatically open a freshly generated login QR with the system
      // image viewer, so the user doesn't have to hunt for qrcode.png.
      const onQrcode = (imagePath: string) => {
        console.log(`[NapCat] 自动打开登录二维码: ${imagePath}`);
        void shell.openPath(imagePath);
        broadcast('napcat-qrcode', imagePath);
      };

      // If we already have a logged-in account, auto-configure and boot directly.
      const uin = payload.uin || det.uins[0];
      if (uin) {
        napcatManager.configureForwardWs(uin, port, token);
        napcatManager.start({
          shellDir: det.shellDir!,
          launcherExe: det.launcherExe,
          qqExe: det.qqExe,
          uin,
          port,
          token,
          onQrcode
        });
        return { started: true, uin, needsLogin: false };
      }

      // No account yet → boot without a uin so NapCat shows its own login UI.
      napcatManager.start({
        shellDir: det.shellDir!,
        launcherExe: det.launcherExe,
        qqExe: det.qqExe,
        uin: '',
        port,
        token,
        onQrcode
      });
      return { started: true, uin: '', needsLogin: true };
    }
  );

  ipcMain.handle('napcat:stop', async () => {
    napcatManager.stop();
    return true;
  });

  ipcMain.handle('napcat:refreshAccounts', async () => {
    const det = await napcatManager.detect(ctx.getNapcatDir() ?? undefined);
    return det.uins;
  });

  ipcMain.handle('napcat:configure', (_event, uin: string, port?: number, token?: string) => {
    const p = port ?? napcatManager.getConfiguredPort();
    const t = token ?? getConfig().napcatToken;
    napcatManager.configureForwardWs(uin, p, t);
    // Keep the app's own config in sync so the bot connects to the same port.
    if (p !== napcatManager.getConfiguredPort()) {
      getConfigStore().update({ napcatWs: `ws://127.0.0.1:${p}` });
    }
    return { port: p, tokenSet: !!t };
  });
};
