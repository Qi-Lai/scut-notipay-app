import { BrowserWindow } from 'electron';
import path from 'path';
import type { ChartRequest } from '../core/presentation';

let chartWindow: BrowserWindow | null = null;
let readyPromise: Promise<void> | null = null;
// Serialize renders: a single hidden window renders one chart at a time
let queue: Promise<unknown> = Promise.resolve();

const getChartWindow = (): BrowserWindow => {
  if (chartWindow && !chartWindow.isDestroyed()) {
    return chartWindow;
  }
  chartWindow = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  const htmlPath = path.join(__dirname, '..', 'renderer', 'chart.html');
  readyPromise = chartWindow
    .loadFile(htmlPath)
    .then(() => chartWindow!.webContents.executeJavaScript('window.__chartReady === true'))
    .then((ready) => {
      if (!ready) throw new Error('Chart renderer failed to initialize');
    });
  chartWindow.on('closed', () => {
    chartWindow = null;
    readyPromise = null;
  });
  return chartWindow;
};

/**
 * Render a Chart.js configuration to a PNG buffer using a hidden
 * Chromium window (replaces node-canvas from upstream).
 */
export const renderChartPng = (request: ChartRequest): Promise<Buffer> => {
  const run = async (): Promise<Buffer> => {
    const win = getChartWindow();
    await readyPromise;

    const dataUrl: string = await win.webContents.executeJavaScript(
      `window.__renderChart(${JSON.stringify(request.config)}, ${request.width}, ${request.height})`
    );

    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!match) {
      throw new Error('Chart renderer returned an invalid data URL');
    }
    return Buffer.from(match[1], 'base64');
  };

  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
};
