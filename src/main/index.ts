import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import { execSync } from 'child_process';
import path from 'path';
import { hookConsole } from './logger';

// Hook console before anything else so all core logs reach the UI
hookConsole();

import { initConfig, getConfig, getConfigStore } from '../core/config';
import { initDatabase, closeDatabase } from '../core/database';
import { getDataDir } from '../core/data-location';
import { Bot } from '../core/bot';
import { renderChartPng } from './charts';
import { registerIpcHandlers } from './ipc';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bot: Bot | null = null;
let quitting = false;

const getVersionTag = (): string => {
  try {
    const hash = execSync('git rev-parse HEAD').toString().trim().slice(0, 7);
    return hash;
  } catch {
    return `v${app.getVersion()}`;
  }
};

const getBot = (): Bot => {
  if (!bot) {
    bot = new Bot({
      renderChart: renderChartPng,
      versionTag: getVersionTag()
    });
    bot.on('state', (state) => broadcast('bot-state', state));
    bot.on('schedule', (nextRunAt: Date | null) =>
      broadcast('schedule', nextRunAt ? nextRunAt.toISOString() : null)
    );
    bot.on('students-changed', () => broadcast('students-changed'));
    bot.on('notifications-changed', () => broadcast('notifications-changed'));
    bot.on('hourly-complete', () => broadcast('hourly-complete'));
  }
  return bot;
};

const broadcast = (channel: string, payload?: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

const restartBot = async (): Promise<void> => {
  const instance = getBot();
  await instance.stop();
  await instance.start();
};

const getIconPath = (): string => path.join(__dirname, '..', '..', 'build', 'icon.png');

const createMainWindow = (): void => {
  const icon = nativeImage.createFromPath(getIconPath());

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'SCUT NotiPay 管理面板',
    icon,
    backgroundColor: '#0f1420',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Minimize to tray instead of closing — the bot keeps running in background
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

const createTray = (): void => {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('SCUT NotiPay');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createMainWindow();
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createMainWindow();
    }
  });
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  void app.whenReady().then(async () => {
    const dataDir = getDataDir();
    initConfig(dataDir);
    initDatabase(path.join(dataDir, 'data.db'));
    console.log(`[App] Data directory: ${dataDir}`);

    registerIpcHandlers({
      getBot,
      restartBot,
      getNapcatDir: () => getConfig().napcatDir || null,
      setNapcatDir: (dir) => {
        if (dir !== null && getConfig().napcatDir !== dir) {
          getConfigStore().update({ napcatDir: dir });
        }
      }
    });
    createMainWindow();
    createTray();

    // Poll NapCat availability so the dashboard card stays live.
    const { napcatManager } = await import('../core/napcat-manager');
    napcatManager.startPolling(3000, (status) => broadcast('napcat-status', status));

    if (getConfig().autoStart) {
      console.log('[Bot] Auto-start enabled, connecting to NapCat...');
      try {
        await getBot().start();
      } catch (error) {
        console.error('[Bot] Auto-start failed:', error);
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    // Keep running in tray on all platforms except explicit quit
  });

  app.on('will-quit', async (event) => {
    if (bot && bot.getState() !== 'stopped') {
      event.preventDefault();
      await bot.stop();
      closeDatabase();
      console.log('[App] Shutdown complete.');
      app.quit();
    } else {
      closeDatabase();
    }
  });

  app.on('quit', () => {
    const { napcatManager } = require('../core/napcat-manager');
    napcatManager.dispose();
  });
}
