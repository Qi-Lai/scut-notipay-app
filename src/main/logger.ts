import { BrowserWindow } from 'electron';
import { inspect } from 'util';

export interface LogEntry {
  time: string;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
}

const MAX_ENTRIES = 800;
const buffer: LogEntry[] = [];
let hooked = false;

const formatArgs = (args: unknown[]): string =>
  args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'object') {
        try {
          return inspect(arg, { depth: 3, breakLength: 120 });
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');

const broadcast = (entry: LogEntry): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('log', entry);
    }
  }
};

const push = (level: LogEntry['level'], args: unknown[]): void => {
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    text: formatArgs(args)
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  broadcast(entry);
};

/**
 * Intercept console.* so every log line from the bot core is
 * mirrored into the UI's log panel (and kept in a ring buffer).
 */
export const hookConsole = (): void => {
  if (hooked) return;
  hooked = true;

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      try {
        push(level, args);
      } catch {
        // never break logging
      }
    };
  }
};

export const getLogBuffer = (): LogEntry[] => [...buffer];
