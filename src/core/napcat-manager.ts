import { spawn, execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { EventEmitter } from 'events';
import { getConfigStore } from './config';

/**
 * OneBot11 config: `<napcatDir>/config/onebot11_<uin>.json`.
 *
 * We do NOT assume a fixed field set — NapCat's schema evolves across
 * versions. Instead we do a "conservative surgery": locate an existing
 * forward WS entry by host+port, flip only its `enable`/`token`, and leave
 * every other field (including unknown future fields) untouched. If there's
 * no WS entry yet, we add a minimal one using the shape already present in
 * the file (or a tiny default).
 */
export type NapCatStatus = 'not-found' | 'stopped' | 'running' | 'no-login';

export interface NapCatDetectResult {
  found: boolean;
  dir: string | null;
  shellDir: string | null;
  launcherExe: string | null;
  qqExe: string | null;
  configDir: string | null;
  uins: string[];
  webuiUrl: string | null;
  webuiToken: string | null;
}

interface OneBotFile {
  network?: {
    websocketServers?: Record<string, unknown>[];
    websocketClients?: Record<string, unknown>[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class NapCatManager extends EventEmitter {
  private detected: NapCatDetectResult | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;

  /**
   * Find an existing NapCat installation. Prefers a user-specified dir, then
   * the path derived from the installed QQ (via its registry uninstall entry,
   * which is the framework's own source of truth), then a small set of known
   * one-key layouts.
   */
  async detect(dirHint?: string): Promise<NapCatDetectResult> {
    for (const candidate of this.candidates(dirHint)) {
      const found = this.probeDir(candidate);
      if (found) {
        this.detected = found;
        this.emit('detected', found);
        return found;
      }
    }
    this.detected = this.empty();
    return this.detected;
  }

  private *candidates(dirHint?: string): Generator<string> {
    const seen = new Set<string>();
    const push = (p?: string | null) => {
      if (p && !seen.has(p)) {
        seen.add(p);
        return p;
      }
      return null;
    };

    const direct = push(dirHint);
    if (direct) yield direct;

    const regQq = this.locateQqFromRegistry();
    if (regQq) {
      const based = push(path.dirname(regQq));
      if (based) yield based;
      // OneKey layout: `...\NapCat.Shell.Windows.OneKey` beside QQ
      const oneKey = push(path.join(path.dirname(regQq), 'NapCat.Shell.Windows.OneKey'));
      if (oneKey) yield oneKey;
    }

    if (push(this.envNapcatDir())) yield this.envNapcatDir()!;

    // Normalize separators: pass drive letters with a forward slash so
    // `path.join` produces a correct absolute path regardless of shell context.
    for (const base of this.driveRoots()) {
      const oneKey = push(path.join(base, 'NapCat.Shell.Windows.OneKey'));
      if (oneKey) yield oneKey;
      const plain = push(path.join(base, 'NapCat'));
      if (plain) yield plain;
    }
  }

  private driveRoots(): string[] {
    const roots = ['C', 'D'];
    const extras = ['C:/Program Files'];
    // Only include drives that exist on the host.
    return roots
      .map((d) => `${d}:/`)
      .filter((d) => fs.existsSync(d))
      .concat(extras.filter((e) => fs.existsSync(e)));
  }

  private envNapcatDir(): string | null {
    const v = process.env.NAPCAT_DIR;
    return v && v.trim() ? v.trim() : null;
  }

  /**
   * Locate QQ.exe via the installed QQ's registry uninstall entry — the same
   * approach the official launcher.bat uses.
   */
  private locateQqFromRegistry(): string | null {
    const roots = [
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ'
    ];
    for (const key of roots) {
      try {
        const out = execFileSync('reg', ['query', key, '/v', 'UninstallString'], {
          encoding: 'utf8'
        });
        const m = /UninstallString\s+REG_\w+\s+(.+)/.exec(out);
        if (m) {
          const uninst = m[1].trim();
          // UninstallString often points to an uninstaller in the install dir
          const dir = path.dirname(uninst);
          if (fs.existsSync(path.join(dir, 'QQ.exe'))) return path.join(dir, 'QQ.exe');
          if (fs.existsSync(uninst)) return uninst;
        }
      } catch {
        // key not present or reg unavailable
      }
    }
    return null;
  }

  private probeDir(dir: string): NapCatDetectResult | null {
    if (!dir || !fs.existsSync(dir)) return null;
    const shellDir = this.findShellDir(dir);
    if (!shellDir) return null;

    const launcherExe = path.join(shellDir, 'NapCatWinBootMain.exe');
    const configDir = path.join(shellDir, 'config');
    const uins = this.listUins(configDir);
    const webui = this.readWebUiToken(configDir);

    return {
      found: true,
      dir,
      shellDir,
      launcherExe: fs.existsSync(launcherExe) ? launcherExe : null,
      qqExe: this.findQqExe(dir, shellDir),
      configDir,
      uins,
      webuiUrl: webui.port ? `http://127.0.0.1:${webui.port}` : null,
      webuiToken: webui.token
    };
  }

  private findShellDir(dir: string): string | null {
    if (fs.existsSync(path.join(dir, 'napcat.mjs'))) return dir;
    const direct = path.join(dir, 'NapCat.Shell');
    if (fs.existsSync(path.join(direct, 'napcat.mjs'))) return direct;
    return null;
  }

  /**
   * Locate the QQ.exe that NapCat is meant to inject.
   *
   * IMPORTANT: NapCat's injection hook is compiled for a *specific* QQ build.
   * The OneKey package ships a self-contained, version-matched QQ instance in
   * a sub-folder (e.g. `NapCat.44498.Shell`) that has its own `QQ.exe` +
   * `versions/` + matching `NapCatWinBootMain.exe`/`NapCatWinBootHook.dll`.
   * Hooking the *system* installed QQ (which may have auto-updated to a newer
   * build) breaks the hook → "file corrupted". So we must prefer the bundled
   * QQ over any registry-located installed QQ.
   */
  private findQqExe(dir: string, shellDir: string): string | null {
    const candidates = [
      // 1) NapCat's self-contained, version-matched QQ sub-folder
      this.findBundledQq(dir),
      // 2) fallbacks
      path.join(shellDir, 'QQ.exe'),
      path.join(dir, 'QQ.exe'),
      path.join(dir, '..', 'QQ.exe')
    ].filter(Boolean);
    for (const c of candidates as string[]) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * Find the self-contained QQ instance folder shipped with the OneKey bundle
   * (a sibling dir named like `NapCat.<buildId>.Shell` containing its own
   * `QQ.exe` + `versions/`). Returns its QQ.exe path, or null.
   */
  private findBundledQq(dir: string): string | null {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const qqPath = path.join(dir, entry.name, 'QQ.exe');
        const hasVersions = fs.existsSync(path.join(dir, entry.name, 'versions'));
        if (fs.existsSync(qqPath) && hasVersions && entry.name.startsWith('NapCat.')) {
          return qqPath;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private listUins(configDir: string | null): string[] {
    if (!configDir || !fs.existsSync(configDir)) return [];
    const re = /^onebot11_(\d+)\.json$/i;
    return fs
      .readdirSync(configDir)
      .filter((f) => re.test(f))
      .map((f) => f.match(re)![1]);
  }

  private readWebUiToken(configDir: string | null): { port: number | null; token: string | null } {
    if (!configDir) return { port: null, token: null };
    const file = path.join(configDir, 'webui.json');
    try {
      if (!fs.existsSync(file)) return { port: null, token: null };
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { port?: number; token?: string };
      return { port: data.port ?? null, token: data.token ?? null };
    } catch {
      return { port: null, token: null };
    }
  }

  private empty(): NapCatDetectResult {
    return {
      found: false,
      dir: null,
      shellDir: null,
      launcherExe: null,
      qqExe: null,
      configDir: null,
      uins: [],
      webuiUrl: null,
      webuiToken: null
    };
  }

  // ------------------------------------------------------------------
  // Config "conservative surgery"
  // ------------------------------------------------------------------

  readOneBot11(uin: string): OneBotFile | null {
    const conf = this.detected?.configDir;
    if (!conf) return null;
    const file = path.join(conf, `onebot11_${uin}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as OneBotFile;
    } catch {
      return null;
    }
  }

  /**
   * Ensure exactly one forward WS entry (host 127.0.0.1, given port) exists,
   * is enabled, and uses the given token. Preserves all other fields.
   */
  configureForwardWs(uin: string, port: number, token: string): void {
    const conf = this.detected?.configDir;
    if (!conf) throw new Error('NapCat 目录未找到');
    const file = path.join(conf, `onebot11_${uin}.json`);

    let config: OneBotFile;
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8')) as OneBotFile;
    } catch {
      config = {};
    }
    if (!config.network) config.network = {};
    if (!Array.isArray(config.network.websocketServers))
      config.network.websocketServers = [];

    const servers = config.network.websocketServers;
    const index = servers.findIndex(
      (s) => s.host === '127.0.0.1' && s.port === port
    );
    const existing = index >= 0 ? servers[index] : {};

    // Conservative surgery: flip only what we own, keep everything else.
    servers[index >= 0 ? index : servers.length] = {
      ...existing,
      name: existing.name ?? 'scut-notipay-forward',
      enable: true,
      host: '127.0.0.1',
      port,
      token
    } as Record<string, unknown>;

    fs.mkdirSync(conf, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  start(config: {
    shellDir: string;
    launcherExe: string | null;
    qqExe: string | null;
    uin: string;
    port: number;
    token: string;
    /** Called when a fresh login QR code image is written to cache. */
    onQrcode?: (imagePath: string) => void;
  }): void {
    if (!config.shellDir) throw new Error('NapCat Shell 目录未找到');
    const { launcherExe } = config;
    if (!launcherExe || !fs.existsSync(launcherExe)) {
      throw new Error('NapCatWinBootMain.exe 未找到，NapCat 安装不完整');
    }

    if (config.uin) {
      this.configureForwardWs(config.uin, config.port, config.token);
    }

    const mainPath = path.join(config.shellDir, 'napcat.mjs').replace(/\\/g, '/');
    const env = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: path.join(config.shellDir, 'qqnt.json'),
      NAPCAT_LOAD_PATH: path.join(config.shellDir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: path.join(config.shellDir, 'NapCatWinBootHook.dll'),
      NAPCAT_LAUNCHER_PATH: config.launcherExe || '',
      NAPCAT_MAIN_PATH: mainPath
    };

    // The boot main expects a stub that imports napcat.mjs.
    const loadPath = path.join(config.shellDir, 'loadNapCat.js');
    fs.writeFileSync(
      loadPath,
      `(async () => { await import("file:///${mainPath}") })()` + '\n',
      'utf8'
    );

    // Generate a launcher script that mirrors the official `launcher.bat`
    // including its self-elevation: it detects it is not running as
    // Administrator and relaunches itself with `-Verb runAs` (UAC prompt).
    //
    // IMPORTANT: the script is written to a FIXED path inside the NapCat
    // directory (not a temp file) and is NEVER deleted. A temp path breaks
    // self-elevation because the elevated `%~f0` must still exist — deleting
    // it while the elevated cmd is launching caused the repeated
    // "opens-then-closes" window loop the user observed.
    //
    // Keep the bat ASCII-only to avoid mojibake in the cmd console; any
    // Chinese messaging is shown by the app itself instead.
    const qqPath = config.qqExe && fs.existsSync(config.qqExe) ? config.qqExe : '';
    const batPath = path.join(config.shellDir, 'start-napcat.bat');
    const bat = `@echo off
cd /d "${config.shellDir}"
chcp 65001 >nul
net session >nul 2>&1
if %ERRORLEVEL% == 0 (
    goto :run
)
echo Requesting admin elevation...
powershell -Command "Start-Process -FilePath '%~f0' -Verb runAs"
exit /b
:run
set "NAPCAT_PATCH_PACKAGE=${path.join(config.shellDir, 'qqnt.json')}"
set "NAPCAT_LOAD_PATH=${path.join(config.shellDir, 'loadNapCat.js')}"
set "NAPCAT_INJECT_PATH=${path.join(config.shellDir, 'NapCatWinBootHook.dll')}"
set "NAPCAT_LAUNCHER_PATH=${config.launcherExe}"
set "NAPCAT_MAIN_PATH=${mainPath}"
set "QQ_PATH=${qqPath}"
"%NAPCAT_LAUNCHER_PATH%" "%QQ_PATH%" "%NAPCAT_INJECT_PATH%"${config.uin ? ` ${config.uin}` : ''}
pause
`;
    fs.writeFileSync(batPath, bat, 'utf8');

    // Launch the script (non-elevated): the bat self-elevates via UAC, then
    // runs the boot main inside a visible console that stays open (pause),
    // so the user sees the QQ scan window. We do NOT delete the bat.
    const child = spawn('cmd.exe', ['/c', batPath], {
      cwd: config.shellDir,
      env,
      detached: false,
      windowsHide: false,
      stdio: 'ignore'
    });
    child.on('error', (err: Error) => this.emit('log', `[NapCat] 启动失败: ${err.message}`));
    this.emit('log', `[NapCat] 已发出启动请求 (uin=${config.uin || '未登录'})，请在 UAC 窗口点击“是”`);

    // Watch for a freshly written login QR code so the app can auto-open it.
    if (config.onQrcode) {
      this.watchQrcode(config.shellDir, config.onQrcode);
    }
  }

  /**
   * Poll `<shellDir>/cache/qrcode.png` and invoke `onQrcode` once when it is
   * created or modified after we started watching (i.e. a new login QR was
   * generated). The callback (in the Electron main process) opens it with the
   * system image viewer so the user never has to hunt for the file.
   */
  private watchQrcode(shellDir: string, onQrcode: (path: string) => void): void {
    const qrPath = path.join(shellDir, 'cache', 'qrcode.png');
    // Baseline mtime; only a change after this point is a "fresh" QR.
    let lastMtime = 0;
    try {
      if (fs.existsSync(qrPath)) lastMtime = fs.statSync(qrPath).mtimeMs;
    } catch {
      // ignore
    }

    const startedAt = Date.now();
    let fired = false;
    const timer = setInterval(() => {
      // Stop watching once it has fired or after 3 minutes (QR expires).
      if (fired || Date.now() - startedAt > 3 * 60 * 1000) {
        clearInterval(timer);
        return;
      }
      try {
        if (!fs.existsSync(qrPath)) return;
        const mtime = fs.statSync(qrPath).mtimeMs;
        if (mtime > lastMtime + 500) {
          // Fresh QR detected.
          fired = true;
          clearInterval(timer);
          this.emit('qrcode', qrPath);
          onQrcode(qrPath);
        }
      } catch {
        // ignore transient fs errors
      }
    }, 1000);
    this.emit('log', `[NapCat] 已启动二维码监视（将自动打开登录二维码）`);
  }

  stop(): void {
    try {
      execFile('taskkill', ['/f', '/im', 'QQ.exe'], { windowsHide: true }, () => {
        this.emit('log', '[NapCat] QQ.exe 已结束');
      });
    } catch {
      // ignore
    }
  }

  isQqRunning(): boolean {
    try {
      const out = execFileSync('tasklist', ['/fi', 'imagename eq QQ.exe', '/fo', 'csv', '/nh'], {
        encoding: 'utf8'
      });
      return /QQ\.exe/i.test(out);
    } catch {
      return false;
    }
  }

  isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port, timeout: 1200 });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  getConfiguredPort(): number {
    const u = new URL(getConfigStore().get().napcatWs || '');
    const p = Number(u.port);
    return Number.isInteger(p) && p > 0 ? p : 3001;
  }

  async status(): Promise<NapCatStatus> {
    if (!this.detected?.found) await this.detect();
    if (!this.detected?.found) return 'not-found';

    const port = this.getConfiguredPort();
    try {
      const portOpen = await this.isPortOpen(port);
      // The *only* reliable signal that NapCat has taken effect is the WS
      // port actually listening. A running QQ.exe is NOT evidence — it may
      // be the user's normal (non-injected) QQ. So:
      //   port open  -> NapCat 生效，running
      //   port shut  -> 视账号而定：有已登录账号=stopped(可重开)，无=no-login
      if (portOpen) return 'running';
      return this.detected.uins.length > 0 ? 'stopped' : 'no-login';
    } catch {
      return 'stopped';
    }
  }

  startPolling(intervalMs = 3000, onStatus?: (status: NapCatStatus) => void): void {
    this.stopPolling();
    this.watcherTimer = setInterval(async () => {
      const status = await this.status();
      if (onStatus) onStatus(status);
      this.emit('status', status);
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.watcherTimer) {
      clearInterval(this.watcherTimer);
      this.watcherTimer = null;
    }
  }

  dispose(): void {
    this.stopPolling();
  }
}

export const napcatManager = new NapCatManager();
