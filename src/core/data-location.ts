import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * Manages the application's data directory location.
 *
 * By default data lives in Electron's `userData` dir (e.g. AppData/Roaming/
 * scut-notipay-app). A user may choose a custom directory to avoid filling up
 * the system drive. We store that choice in a tiny pointer file inside the
 * DEFAULT userData dir so we always know where to look for the pointer even
 * after the data dir has moved.
 */
interface DataLocation {
  /** Custom data directory. Empty string = use the default userData dir. */
  path: string;
}

const POINTER_FILENAME = 'data-location.json';
const DB_FILENAME = 'data.db';

// The default install dir — also where the pointer file always lives.
export const defaultDataDir = (): string => app.getPath('userData');

const pointerPath = (): string => path.join(defaultDataDir(), POINTER_FILENAME);

function readPointer(): DataLocation {
  try {
    if (fs.existsSync(pointerPath())) {
      const raw = JSON.parse(fs.readFileSync(pointerPath(), 'utf8')) as DataLocation;
      if (typeof raw.path === 'string') return raw;
    }
  } catch {
    // ignore malformed pointer
  }
  return { path: '' };
}

/**
 * Resolve the active data directory: the custom one if set and valid,
 * otherwise the default userData dir.
 */
export const getDataDir = (): string => {
  const { path: custom } = readPointer();
  if (custom && fs.existsSync(custom)) {
    return custom;
  }
  return defaultDataDir();
};

export const hasCustomDataDir = (): boolean => {
  const { path: custom } = readPointer();
  return !!(custom && fs.existsSync(custom));
};

/**
 * Migrate the data dir (config.json + data.db[+-wal/-shm]) to `targetDir` and
 * record it in the pointer file. Returns the new dir on success.
 *
 * NOTE: call `closeDatabase()` BEFORE this so the DB file isn't locked.
 */
export const migrateDataDir = (targetDir: string): string => {
  const src = getDataDir();
  const dst = targetDir;

  fs.mkdirSync(dst, { recursive: true });

  // Copy config.json if present.
  const srcConfig = path.join(src, 'config.json');
  const dstConfig = path.join(dst, 'config.json');
  if (fs.existsSync(srcConfig)) {
    fs.copyFileSync(srcConfig, dstConfig);
  }

  // Always copy the SQLite DB (and its WAL/SHM siblings if present).
  for (const name of [DB_FILENAME, `${DB_FILENAME}-wal`, `${DB_FILENAME}-shm`]) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
  }

  // Record the new location in the pointer file (lives in the default dir).
  fs.writeFileSync(pointerPath(), JSON.stringify({ path: dst }, null, 2), 'utf8');

  return dst;
};

export const dataDirFiles = (): string[] => [DB_FILENAME, 'config.json'];
