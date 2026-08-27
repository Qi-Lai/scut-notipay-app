import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

export interface AppConfig {
  /** NapCat WebSocket address, e.g. ws://127.0.0.1:3001 */
  napcatWs: string;
  /** NapCat access token */
  napcatToken: string;
  /** Master key used to encrypt stored card passwords */
  encryptionKey: string;
  /** Command names the bot responds to */
  commandNames: string[];
  /** Billing query retry count */
  billingRetryCount: number;
  /** Optional proxy URL applied to all campus HTTP requests (http:// or socks5://) */
  proxy: string;
  /** Whether the bot connects to NapCat automatically when the app starts */
  autoStart: boolean;
  /** User-selected NapCat install directory (empty = auto-detect) */
  napcatDir: string;
}

const DEFAULTS: Omit<AppConfig, 'encryptionKey'> = {
  napcatWs: 'ws://127.0.0.1:3001',
  napcatToken: '',
  commandNames: ['scut-notipay', 'snp'],
  billingRetryCount: 3,
  proxy: '',
  autoStart: true,
  napcatDir: ''
};

/**
 * Runtime-editable configuration persisted to a JSON file in the
 * application's user data directory (replaces upstream's static
 * config.json import so settings can be changed from the UI).
 */
export class ConfigStore {
  private filePath: string;
  private config: AppConfig;

  constructor(dir: string) {
    this.filePath = path.join(dir, 'config.json');
    this.config = this.load();
  }

  private load(): AppConfig {
    let onDisk: Partial<AppConfig> = {};
    try {
      if (fs.existsSync(this.filePath)) {
        onDisk = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (error) {
      console.error('[Config] Failed to read config file, using defaults:', error);
    }

    const merged: AppConfig = {
      ...DEFAULTS,
      ...onDisk,
      encryptionKey:
        typeof onDisk.encryptionKey === 'string' && onDisk.encryptionKey.length > 0
          ? onDisk.encryptionKey
          : randomBytes(32).toString('hex')
    };

    // Persist immediately so a generated encryption key stays stable
    this.config = merged;
    this.save(merged);
    return merged;
  }

  get(): AppConfig {
    return { ...this.config, commandNames: [...this.config.commandNames] };
  }

  update(patch: Partial<AppConfig>): AppConfig {
    const next: AppConfig = {
      ...this.config,
      ...patch,
      encryptionKey:
        typeof patch.encryptionKey === 'string' && patch.encryptionKey.length > 0
          ? patch.encryptionKey
          : this.config.encryptionKey
    };
    if (!Array.isArray(next.commandNames) || next.commandNames.length === 0) {
      next.commandNames = [...DEFAULTS.commandNames];
    }
    if (typeof next.billingRetryCount !== 'number' || next.billingRetryCount < 0) {
      next.billingRetryCount = DEFAULTS.billingRetryCount;
    }
    this.save(next);
    this.config = next;
    return this.get();
  }

  private save(config: AppConfig): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
      console.error('[Config] Failed to write config file:', error);
    }
  }

  /** Apply the configured proxy to the process environment (used by fetch.ts) */
  applyProxy(): void {
    const proxy = this.config.proxy?.trim();
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'SOCKS_PROXY', 'SOCKS5_PROXY']) {
      delete process.env[key];
    }
    if (!proxy) return;
    if (/^socks5?:\/\//i.test(proxy)) {
      process.env.SOCKS_PROXY = proxy;
    } else {
      process.env.HTTP_PROXY = proxy;
      process.env.HTTPS_PROXY = proxy;
    }
  }
}

let store: ConfigStore | null = null;

export const initConfig = (dir: string): ConfigStore => {
  store = new ConfigStore(dir);
  store.applyProxy();
  return store;
};

export const getConfig = (): AppConfig => {
  if (!store) throw new Error('Config not initialized');
  return store.get();
};

export const getConfigStore = (): ConfigStore => {
  if (!store) throw new Error('Config not initialized');
  return store;
};
