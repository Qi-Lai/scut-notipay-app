import { EventEmitter } from 'events';
import { NCWebsocket } from 'node-napcat-ts';
import type { AllHandlers, SendMessageSegment } from 'node-napcat-ts';
import { getConfig } from './config';
import { obtainToken as login } from './session';
import { getBills } from './billing';
import { getDb, getScheduler, type Campus } from './database';
import {
  buildBillingChartRequests,
  generateBillingSummary,
  type ChartRequest
} from './presentation';
import {
  APP_NAME,
  CAMPUSES,
  DATA_COLLECTION_BATCH_SIZE,
  GITHUB_LINK
} from './constants';
import { parseRelativeTime, calculateNextFetchTime, parseTimeParameter } from './timeparse';

export type BotState = 'stopped' | 'connecting' | 'online' | 'offline';

export interface BotDeps {
  /** Render a chart request to a PNG buffer (offscreen Chromium in main process) */
  renderChart: (request: ChartRequest) => Promise<Buffer>;
  /** Short commit hash or app version shown in the help message */
  versionTag: string;
}

/**
 * Type for collected student billing data
 */
type CollectedData = {
  qqId: string;
  name: string | null | undefined;
  electric: number;
  water: number;
  ac: number;
  room: string;
  success: boolean;
  error?: Error;
};

// Small generic signallable promise: call `signal()` to resolve the promise.
const createSignallable = <T>() => {
  let resolver: (value: T) => void = () => undefined as unknown as void;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    signal(value: T) {
      resolver(value);
    }
  } as { promise: Promise<T>; signal: (value: T) => void };
};

export class Bot extends EventEmitter {
  private napcat: NCWebsocket | null = null;
  private deps: BotDeps;
  private state: BotState = 'stopped';
  private hourlyTimeout: NodeJS.Timeout | null = null;
  private hourlyInterval: NodeJS.Timeout | null = null;
  private nextRunAt: Date | null = null;
  private socketClose = createSignallable<void>();
  private running = false;

  constructor(deps: BotDeps) {
    super();
    this.deps = deps;
  }

  getState(): BotState {
    return this.state;
  }

  getNextRunAt(): Date | null {
    return this.nextRunAt;
  }

  private setState(state: BotState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('state', state);
    }
  }

  async start(): Promise<void> {
    if (this.napcat) {
      console.log('[Bot] Already started');
      return;
    }
    const config = getConfig();
    this.running = true;
    this.setState('connecting');

    this.napcat = new NCWebsocket(
      {
        baseUrl: config.napcatWs,
        accessToken: config.napcatToken,
        reconnection: {
          enable: true,
          attempts: 10,
          delay: 5000
        }
      },
      false
    );

    this.napcat.on('socket.open', () => {
      console.log('[NapCat] Connected.');
      this.setState('online');
      this.startHourlyTimer();
    });

    this.napcat.on('socket.close', () => {
      console.log('[NapCat] Disconnected.');
      this.setState(this.running ? 'offline' : 'stopped');
      try {
        this.socketClose.signal(undefined);
      } catch {
        // ignore if already resolved
      }
    });

    this.napcat.on('socket.error', (context: AllHandlers['socket.error']) => {
      console.error('[NapCat] Socket error:', context?.error_type ?? 'unknown');
    });

    this.napcat.on('message', (context: AllHandlers['message']) => {
      void this.handleMessage(context);
    });

    try {
      await this.napcat.connect();
    } catch (error) {
      console.error('[NapCat] Connect failed:', error);
      this.setState('offline');
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHourlyTimer();
    if (!this.napcat) {
      this.setState('stopped');
      return;
    }
    const napcat = this.napcat;
    this.napcat = null;
    this.socketClose = createSignallable<void>();

    try {
      napcat.disconnect();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      await Promise.race([this.socketClose.promise, timeout]);
    } catch {
      // ignore
    }
    this.setState('stopped');
    console.log('[Bot] Stopped.');
  }

  // ------------------------------------------------------------------
  // Token / credentials helpers
  // ------------------------------------------------------------------

  private storeToken(
    qqId: string,
    accessToken: string,
    TGC: string,
    locSession: string,
    expiresIn: number
  ): void {
    getDb().updateTokens(qqId, accessToken, TGC, locSession, expiresIn);
    console.log(`[Token] Stored token for QQ ${qqId}, expires in ${expiresIn}s`);
  }

  private async getValidToken(qqId: string): Promise<[string, string, string]> {
    const db = getDb();
    // Try to get stored token
    const storedToken = db.getTokens(qqId);
    if (storedToken) {
      return storedToken;
    }

    // No valid stored token, need to login
    const credentials = db.getCredentials(qqId);
    if (!credentials) {
      throw new Error('No credentials found for user');
    }

    const result = await login(credentials.cardId, credentials.password);
    if (result === null) {
      throw new Error('Login failed');
    }

    // Store the new token
    this.storeToken(qqId, result.access_token, result.TGC, result.locSession, result.expires_in);

    return [result.access_token, result.TGC, result.locSession];
  }

  private getCampus(qqId: string): Campus {
    const result = getDb().getCampus(qqId);

    if (!result) {
      throw new Error('No campus found for user');
    }

    return result;
  }

  private async getBillsWithTokenRefresh(qqId: string) {
    const db = getDb();
    try {
      // First attempt with cached token
      const [token, TGC, locSession] = await this.getValidToken(qqId);
      return await getBills(token, TGC, locSession, this.getCampus(qqId));
    } catch {
      // If getBills failed, the token might be invalid despite not being expired
      // Clear the token and try once more with a fresh login
      db.clearAccessToken(qqId);

      const credentials = db.getCredentials(qqId);
      if (!credentials) {
        throw new Error('No credentials found for user');
      }

      const result = await login(credentials.cardId, credentials.password);
      if (result === null) {
        throw new Error('Login failed');
      }
      this.storeToken(qqId, result.access_token, result.TGC, result.locSession, result.expires_in);

      // Retry with fresh token
      return await getBills(result.access_token, result.TGC, result.locSession, this.getCampus(qqId));
    }
  }

  /**
   * Public: fetch current bills for a user and record history.
   * Used by both the QQ "query" flow and the UI "query now" button.
   */
  async fetchBillsForUser(qqId: string) {
    const db = getDb();
    const bills = await this.getBillsWithTokenRefresh(qqId);
    db.updateLastLogin(qqId);
    db.addBillingHistory(qqId, bills.electric, bills.water, bills.ac, bills.room);
    return bills;
  }

  // ------------------------------------------------------------------
  // Scheduler
  // ------------------------------------------------------------------

  /**
   * Collect billing data for a single student
   */
  private async collectStudentData(student: {
    qq_id: string;
    name?: string | null;
    student_number?: string;
  }): Promise<CollectedData> {
    const db = getDb();
    try {
      // Get credentials
      const credentials = db.getCredentials(student.qq_id);
      if (!credentials) {
        console.log(`[Scheduler] No credentials for QQ ${student.qq_id}, skipping`);
        return {
          qqId: student.qq_id,
          name: student.name,
          electric: 0,
          water: 0,
          ac: 0,
          room: '',
          success: false,
          error: new Error('No credentials found')
        };
      }

      // Get bills with automatic token management
      const { electric, ac, water, room } = await this.getBillsWithTokenRefresh(student.qq_id);

      // Record billing history
      db.addBillingHistory(student.qq_id, electric, water, ac, room);
      console.log(`[Scheduler] Collected data for ${student.name || student.qq_id} (${room})`);
      db.updateLastLogin(student.qq_id);

      return {
        qqId: student.qq_id,
        name: student.name,
        electric,
        water,
        ac,
        room,
        success: true
      };
    } catch (error) {
      console.error(`[Scheduler] Failed to collect data for QQ ${student.qq_id}:`, error);
      return {
        qqId: student.qq_id,
        name: student.name,
        electric: 0,
        water: 0,
        ac: 0,
        room: '',
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Process students in parallel batches
   */
  private async collectData(
    students: { qq_id: string; name?: string | null; student_number?: string }[],
    batchSize: number
  ): Promise<CollectedData[]> {
    const results: CollectedData[] = [];

    for (let i = 0; i < students.length; i += batchSize) {
      const batch = students.slice(i, i + batchSize);
      console.log(
        `[Scheduler] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(students.length / batchSize)} (${batch.length} students)`
      );

      const batchResults = await Promise.all(
        batch.map((student) => this.collectStudentData(student))
      );
      results.push(...batchResults);

      // Small delay between batches to avoid overwhelming the server
      if (i + batchSize < students.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  /**
   * Build the message segments (summary text + chart images) for a report
   */
  private async buildReportSegments(
    qqId: string,
    bills: { electric: number; water: number; ac: number; room: string },
    lines: string,
    historyDays = 7
  ): Promise<SendMessageSegment[]> {
    const db = getDb();
    const { electric, water, ac, room } = bills;

    // Get 24h change
    const change24h = db.getBilling24HourChange(qqId);

    // Get history for chart
    const history = db.getBillingHistory(qqId, historyDays);

    // Generate summary
    let messageText = `🏠 ${room}\n\n`;
    messageText += generateBillingSummary({ electric, water, ac }, change24h || undefined);

    // Build message segments
    const messageSegments: SendMessageSegment[] = [{ type: 'text', data: { text: messageText } }];

    // Add chart images
    if (history.length >= 2) {
      const chartData = history.reverse().map((h) => ({
        timestamp: h.recorded_at,
        electric: h.electric,
        water: h.water,
        ac: h.ac
      }));

      const requests = buildBillingChartRequests(chartData, room, lines);
      for (const request of requests) {
        try {
          const png = await this.deps.renderChart(request);
          const base64Image = `base64://${png.toString('base64')}`;
          messageSegments.push({ type: 'image', data: { file: base64Image } });
        } catch (error) {
          console.error('[Chart] Failed to render chart:', error);
        }
      }
    }

    return messageSegments;
  }

  /**
   * Send notifications for a student based on collected data
   */
  private async sendNotificationForStudent(
    collectedData: CollectedData,
    currentHour: number
  ): Promise<void> {
    if (!collectedData.success) {
      console.log(
        `[Scheduler] Skipping notifications for ${collectedData.name || collectedData.qqId} due to data collection failure`
      );
      return;
    }

    const { qqId, name, electric, water, ac, room } = collectedData;
    const notifications = getScheduler().getNotificationsAtHourForUser(qqId, currentHour);

    for (const notification of notifications) {
      try {
        // Check if threshold is set and if any balance is below it
        let shouldSendNotification = true;
        const lines = notification.lines || 'ewa';

        if (notification.threshold !== null && notification.threshold !== undefined) {
          // Only send if any balance drops below the threshold
          const threshold = notification.threshold;
          shouldSendNotification = false;

          if (lines.toLowerCase().includes('e') && electric >= -10 && electric < threshold)
            shouldSendNotification = true;
          if (lines.toLowerCase().includes('w') && water >= -10 && water < threshold)
            shouldSendNotification = true;
          if (lines.toLowerCase().includes('a') && ac >= -10 && ac < threshold)
            shouldSendNotification = true;

          if (!shouldSendNotification) {
            continue;
          }
        }

        console.log(`[Scheduler] Sending notification to ${name || qqId} (${room})`);

        const messageSegments = await this.buildReportSegments(
          qqId,
          { electric, water, ac, room },
          lines
        );

        // Send message
        if (notification.chat_type && notification.chat_id && this.napcat) {
          if (notification.chat_type === 'private') {
            await this.napcat.send_private_msg({
              user_id: parseInt(notification.chat_id),
              message: messageSegments
            });
          } else {
            await this.napcat.send_group_msg({
              group_id: parseInt(notification.chat_id),
              message: messageSegments
            });
          }
          console.log(
            `[Scheduler] Sent notification to ${notification.chat_type} ${notification.chat_id}`
          );
        }
      } catch (error) {
        console.error(
          `[Scheduler] Failed to send notification for QQ ${qqId} to ${notification.chat_type} ${notification.chat_id}:`,
          error
        );
      }
    }
  }

  /**
   * The hourly collection + notification pass (also callable manually from the UI)
   */
  async runHourlyTasks(): Promise<void> {
    try {
      const db = getDb();
      const now = new Date();
      const minutes = now.getMinutes();
      const currentHour = minutes >= 30 ? (now.getHours() + 1) % 24 : now.getHours();
      console.log(`[Scheduler] Running for hour: ${currentHour}`);

      // Get all students with their notification settings
      const allStudents = db.getAllStudents();
      console.log(`[Scheduler] Checking ${allStudents.length} students`);

      if (allStudents.length === 0) {
        console.log('[Scheduler] No students to process');
        return;
      }

      const studentsToFetch: typeof allStudents = [];

      for (const student of allStudents) {
        let shouldFetch = false;

        // Phase 0 (a): Check notifications
        const notifications = getScheduler().getNotificationsAtHourForUser(
          student.qq_id,
          currentHour
        );
        if (notifications.length > 0) {
          shouldFetch = true;
          console.log(`[Scheduler] Fetching for ${student.qq_id} due to scheduled notification`);
        }

        // Phase 0 (b): Check fetch interval
        if (!shouldFetch) {
          try {
            const intervalHours = parseRelativeTime(student.fetch_interval || '1d');
            const nextFetchTime = calculateNextFetchTime(
              student.last_login,
              student.created_at,
              intervalHours
            );

            // Check if current time is at or after the scheduled fetch time
            // We use a small buffer (5 mins) to handle slight timing differences
            if (now.getTime() >= nextFetchTime.getTime() - 5 * 60 * 1000) {
              shouldFetch = true;
              console.log(
                `[Scheduler] Fetching for ${student.qq_id} due to interval (Next: ${nextFetchTime.toLocaleString()}, Interval: ${student.fetch_interval})`
              );
            }
          } catch (e) {
            console.error(`[Scheduler] Error checking interval for ${student.qq_id}:`, e);
          }
        }

        if (shouldFetch) {
          studentsToFetch.push(student);
        }
      }

      if (studentsToFetch.length === 0) {
        console.log('[Scheduler] No students need fetching this hour');
        return;
      }

      // Phase 1: Collect data in parallel batches
      console.log(
        `[Scheduler] Phase 1: Collecting data for ${studentsToFetch.length} students (batch size: ${DATA_COLLECTION_BATCH_SIZE})...`
      );
      const collectedData = await this.collectData(studentsToFetch, DATA_COLLECTION_BATCH_SIZE);
      const successCount = collectedData.filter((d) => d.success).length;
      const failureCount = collectedData.length - successCount;
      console.log(
        `[Scheduler] Data collection complete: ${successCount} succeeded, ${failureCount} failed`
      );

      // Phase 2: Send notifications serially
      console.log('[Scheduler] Phase 2: Sending notifications...');
      for (const data of collectedData) {
        await this.sendNotificationForStudent(data, currentHour);
      }

      console.log('[Scheduler] Hourly tasks completed');
      this.emit('hourly-complete');
    } catch (error) {
      console.error('[Scheduler] Error during hourly tasks:', error);
    }
  }

  private startHourlyTimer(): void {
    // Clear any existing timers to prevent duplicates on reconnection
    this.stopHourlyTimer();

    // Calculate delay until next top of the hour
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const milliseconds = now.getMilliseconds();

    // Time until next hour (in milliseconds)
    const delayUntilNextHour =
      (60 - minutes - 1) * 60 * 1000 + (60 - seconds) * 1000 - milliseconds;

    this.nextRunAt = new Date(now.getTime() + delayUntilNextHour);
    this.emit('schedule', this.nextRunAt);

    console.log(
      `[Scheduler] Will start in ${Math.round(delayUntilNextHour / 1000 / 60)} minutes (at next hour)`
    );

    // Schedule first run at the top of the next hour
    this.hourlyTimeout = setTimeout(() => {
      void this.runHourlyTasks();

      // Then run every hour on the hour
      this.hourlyInterval = setInterval(() => void this.runHourlyTasks(), 60 * 60 * 1000);
      this.nextRunAt = new Date(Date.now() + 60 * 60 * 1000);
      this.emit('schedule', this.nextRunAt);
      this.hourlyTimeout = null;
      console.log('[Scheduler] Timer started (runs every hour on the hour)');
    }, delayUntilNextHour);
  }

  private stopHourlyTimer(): void {
    if (this.hourlyTimeout) {
      clearTimeout(this.hourlyTimeout);
      this.hourlyTimeout = null;
      console.log('[Scheduler] Pending timer cleared');
    }
    if (this.hourlyInterval) {
      clearInterval(this.hourlyInterval);
      this.hourlyInterval = null;
      console.log('[Scheduler] Timer stopped');
    }
    this.nextRunAt = null;
    this.emit('schedule', null);
  }

  // ------------------------------------------------------------------
  // QQ message handling
  // ------------------------------------------------------------------

  private parseMessage(context: AllHandlers['message']) {
    const config = getConfig();
    const message = context.message.find((m) => m.type === 'text');
    if (!message) return { command: null, args: null };
    const text = message.data.text;
    const segments = text
      .split(/\s+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!segments.length) return { command: null, args: null };
    const command = segments[0];
    if (!config.commandNames.includes(command)) return { command: null, args: null };
    return { command, args: segments.slice(1) };
  }

  private async handleNotifyCommand(
    command: string,
    params: string[],
    qqId: string,
    chatType: 'private' | 'group',
    chatId: string,
    sendFn: (message: string) => Promise<void>
  ): Promise<void> {
    const db = getDb();
    const scheduler = getScheduler();

    if (params.length < 1 || params.length > 3) {
      await sendFn(
        `查询定时通知：${command} notify list\n` +
          `设置定时通知：${command} notify <小时 (0-23)> [阈值] [通知项目]`
      );
      return;
    }

    if (params[0] === 'list') {
      const notifications = scheduler.getNotificationsForUser(qqId);
      if (notifications.length === 0) {
        await sendFn('您还未设置定时通知。');
        return;
      }

      notifications.sort((a, b) => a.hour - b.hour);

      let message = '目前设置的定时通知：';
      for (const notification of notifications) {
        message += `\n- ${notification.hour.toString().padStart(2, '0')}:00 ${
          notification.chat_type === 'private'
            ? '私聊'
            : await this.napcat!
                .get_group_info({
                  group_id: parseInt(notification.chat_id)
                })
                .then((info) => info.group_name)
        }`;
        if (notification.threshold !== null && notification.threshold !== undefined) {
          message += ` [${notification.threshold} 元]`;
        }
        if (notification.lines && notification.lines !== 'ewa') {
          message += ` [${notification.lines.toUpperCase()}]`;
        }
      }
      await sendFn(message);
      return;
    }

    const hour = parseInt(params[0]);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      await sendFn('小时必须是 0 到 23 之间的数字。');
      return;
    }

    let threshold: number | undefined;
    let lines = 'ewa';

    for (let i = 1; i < params.length; i++) {
      const param = params[i];
      if (/^[ewaEWA]+$/.test(param)) {
        lines = param;
      } else {
        const val = parseFloat(param);
        if (!isNaN(val) && val >= 0) {
          threshold = val;
        } else {
          await sendFn('参数格式错误。阈值必须是非负数字，通知项目由 e/w/a 组成。');
          return;
        }
      }
    }

    // Check if user has credentials
    const credentials = db.getCredentials(qqId);
    if (!credentials) {
      await sendFn(
        `您还未绑定账号。请私聊发送：${command} bind <卡号> <卡片密码> <校区 (GZIC 或 DXC)> [更新间隔]`
      );
      return;
    }

    // Set notification
    scheduler.setNotification(chatType, chatId, qqId, hour, threshold, lines);

    let message = `已设置每日 ${hour} 时在此${chatType === 'private' ? '私聊' : '群聊'}`;
    if (threshold !== undefined) {
      message += `当任一余额（${lines.toUpperCase()}）低于 ${threshold} 元时`;
    }
    message += '发送账单报告。';

    await sendFn(message);
    console.log(
      `[Notify] Set notification for ${chatType} ${chatId}, QQ ${qqId}, hour ${hour}, threshold ${threshold ?? 'none'}, lines ${lines}`
    );
  }

  private async handleUnnotifyCommand(
    qqId: string,
    chatType: 'private' | 'group',
    chatId: string,
    sendFn: (message: string) => Promise<void>
  ): Promise<void> {
    const deleted = getScheduler().deleteNotification(chatType, chatId, qqId);
    if (deleted) {
      await sendFn('已取消定时通知。');
    } else {
      await sendFn('您还未设置定时通知。');
    }
  }

  private async handleIntervalCommand(
    command: string,
    params: string[],
    qqId: string,
    sendFn: (message: string) => Promise<void>
  ): Promise<void> {
    const db = getDb();

    // Check if user has credentials
    const credentials = db.getCredentials(qqId);
    if (!credentials) {
      await sendFn(
        `您还未绑定账号。请私聊发送：${command} bind <卡号> <卡片密码> <校区 (GZIC 或 DXC)> [更新间隔]`
      );
      return;
    }

    if (params.length === 0) {
      // Get
      const student = db.getStudent(qqId);
      if (student) {
        let message = `当前自动更新间隔：${student.fetch_interval || '1d'}`;
        try {
          const hours = parseRelativeTime(student.fetch_interval || '1d');
          let nextFetch = calculateNextFetchTime(student.last_login, student.created_at, hours);
          const now = new Date();

          // If the calculated next fetch time is in the past, the scheduler will pick it up at the next hour
          if (nextFetch < now) {
            nextFetch = new Date(now);
            if (nextFetch.getMinutes() > 0 || nextFetch.getSeconds() > 0) {
              nextFetch.setHours(nextFetch.getHours() + 1);
            }
            nextFetch.setMinutes(0, 0, 0);
          }

          const timeStr = `${nextFetch.getMonth() + 1}月${nextFetch.getDate()}日 ${nextFetch.getHours()}:00`;
          message += `\n下次自动更新将在 ${timeStr} 进行。`;
        } catch {
          // Ignore error
        }
        await sendFn(message);
      }
      return;
    }

    if (params.length === 1) {
      // Set
      const intervalStr = params[0];
      try {
        const hours = parseRelativeTime(intervalStr);
        if (hours < 1) {
          await sendFn('间隔时间不能小于 1 小时。');
          return;
        }

        db.updateFetchInterval(qqId, intervalStr);

        let message = `已设置自动更新间隔为：${intervalStr}（${hours} 小时）。`;

        // Calculate next fetch time
        const student = db.getStudent(qqId);
        if (student) {
          let nextFetch = calculateNextFetchTime(student.last_login, student.created_at, hours);
          const now = new Date();

          // If the calculated next fetch time is in the past, the scheduler will pick it up at the next hour
          if (nextFetch < now) {
            nextFetch = new Date(now);
            if (nextFetch.getMinutes() > 0 || nextFetch.getSeconds() > 0) {
              nextFetch.setHours(nextFetch.getHours() + 1);
            }
            nextFetch.setMinutes(0, 0, 0);
          }

          const timeStr = `${nextFetch.getMonth() + 1}月${nextFetch.getDate()}日 ${nextFetch.getHours()}:00`;
          message += `\n下次自动更新将在 ${timeStr} 进行。`;
        }

        await sendFn(message);
      } catch {
        await sendFn('时间格式不正确。示例：1d, 12h');
      }
      return;
    }

    await sendFn(`用法：${command} interval [时间间隔]`);
  }

  private async handleHelp(
    command: string,
    sendFn: (message: string | SendMessageSegment[]) => Promise<void>
  ): Promise<void> {
    const message =
      `[${APP_NAME}] 可用命令：\n\n` +
      '1. 绑定账号（仅限私聊）：\n' +
      `${command} bind <卡号> <卡片密码> <校区 (GZIC 或 DXC)> [更新间隔]\n` +
      `   例：${command} bind 123456 123456 GZIC 1d\n` +
      '   更新间隔默认为 1d（1 天），支持 h（小时）、d（天）、w（周）。\n\n' +
      '2. 解绑账号：\n' +
      `${command} unbind\n\n` +
      '3. 查询当前账单：\n' +
      `${command} query [起始时间] [结束时间] [显示项目]\n` +
      '   或\n' +
      `${command} bills [起始时间] [结束时间] [显示项目]\n` +
      '   时间格式支持：\n' +
      '   - 相对时间：7h（7 小时前），3d（3 天前），2w（2 周前）\n' +
      '   - 绝对时间：1030（10 月 30 日 0:00），10302330（10 月 30 日 23:30）\n' +
      '   - 带分隔符：10-30|23:30，10/30|23:30，10/30/23:30\n' +
      '   显示项目（可选）：\n' +
      '   - e：电费，w：水费，a：空调费\n' +
      '   - 组合使用：ew（电费+水费），ewa（全部；默认）\n' +
      `   例：${command} query 7d（显示最近 7 天；默认）\n` +
      `   例：${command} query 1025 1030 e（显示 10 月 25 日至 30 日的电费）\n\n` +
      '4. 查询定时通知：\n' +
      `${command} notify list\n\n` +
      '5. 设置定时通知：\n' +
      `${command} notify <小时 (0-23)> [阈值] [通知项目]\n` +
      `   例：${command} notify 20 10\n` +
      '   每天晚上 8 点当任一余额低于 10 元时发送账单报告。\n' +
      `   例：${command} notify 20 10 e\n` +
      '   每天晚上 8 点当电费低于 10 元时发送账单报告（仅包含电费图表）。\n\n' +
      '6. 取消定时通知：\n' +
      `${command} unnotify\n\n` +
      '7. 设置更新间隔：\n' +
      `${command} interval [时间间隔]\n` +
      `   例：${command} interval 12h\n\n` +
      '尖括号 <> 表示必填参数，中括号 [] 表示可选参数。\n' +
      '如有其他疑问，请联系管理员。\n' +
      `当前版本：${this.deps.versionTag}\n` +
      `GitHub 仓库：${GITHUB_LINK}`;
    await sendFn([{ type: 'node', data: { content: [{ type: 'text', data: { text: message } }] } }]);
  }

  private async handleMessage(context: AllHandlers['message']): Promise<void> {
    const db = getDb();
    const isPrivateChat = context.message_type === 'private';
    const send = async (message: string | SendMessageSegment[]) => {
      if (!this.napcat) return;
      await (isPrivateChat
        ? this.napcat.send_private_msg({
            user_id: context.sender.user_id,
            message:
              typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message
          })
        : this.napcat.send_group_msg({
            group_id: context.group_id,
            message:
              typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message
          }));
    };

    try {
      const { command, args } = this.parseMessage(context);
      if (!command) return;
      if (!args || args.length === 0) {
        await this.handleHelp(command, send);
        return;
      }
      const [subcommand, ...params] = args;
      const qqId = context.sender.user_id.toString();
      const chatId = (isPrivateChat ? context.sender.user_id : context.group_id!).toString();

      if (subcommand === 'bind' && isPrivateChat) {
        if (params.length < 3 || params.length > 4) {
          await send(`用法：${command} ${subcommand} <卡号> <卡片密码> <校区(GZIC 或 DXC)> [更新间隔]`);
          return;
        }
        const [cardId, password, campus, intervalParam] = params;
        if (CAMPUSES.includes(campus.toUpperCase() as Campus) === false) {
          await send('校区必须是 GZIC 或 DXC。');
          return;
        }

        let fetchInterval = '1d';
        if (intervalParam) {
          try {
            const hours = parseRelativeTime(intervalParam);
            if (hours < 1) {
              await send('更新间隔不能小于 1 小时。');
              return;
            }
            fetchInterval = intervalParam;
          } catch {
            await send('更新间隔格式不正确。示例：1d, 12h');
            return;
          }
        }

        console.log(`[Bind] QQ: ${qqId}, Card ID: ${cardId}`);
        const result = await login(cardId, password);
        if (result === null) {
          await send('登录失败，请检查卡号和密码是否正确。');
          return;
        }
        db.addStudent(
          qqId,
          cardId,
          campus.toUpperCase() as Campus,
          password,
          result.name,
          result.sno,
          fetchInterval
        );
        // Store the access token from login
        db.updateTokens(qqId, result.access_token, result.TGC, result.locSession, result.expires_in);
        console.log(`[DB] Stored credentials and token for ${result.name} (${result.sno})`);
        this.emit('students-changed');

        let message = `成功绑定到 ${result.name}（学号：${result.sno}）。`;

        // Calculate first fetch time
        try {
          const hours = parseRelativeTime(fetchInterval);
          const firstFetch = new Date(Date.now() + hours * 60 * 60 * 1000);
          // Round to next hour to match scheduler behavior
          if (firstFetch.getMinutes() > 0 || firstFetch.getSeconds() > 0) {
            firstFetch.setHours(firstFetch.getHours() + 1);
            firstFetch.setMinutes(0, 0, 0);
          }

          const timeStr = `${firstFetch.getMonth() + 1}月${firstFetch.getDate()}日 ${firstFetch.getHours()}:00`;
          message += `\n首次自动更新将在 ${timeStr} 进行（间隔：${fetchInterval}）。`;
        } catch {
          // Ignore error in message generation
        }

        await send(message);
      } else if (subcommand === 'unbind') {
        // Clear token before deleting (though CASCADE will handle this)
        db.clearAccessToken(qqId);
        const deleted = db.deleteStudent(qqId);
        this.emit('students-changed');
        if (deleted) {
          await send('已解除绑定。');
        } else {
          await send('您还未绑定账号。');
        }
      } else if (subcommand === 'query' || subcommand === 'bills') {
        const credentials = db.getCredentials(qqId);
        if (!credentials) {
          await send(
            `您还未绑定账号。请私聊发送：${command} bind <卡号> <卡片密码> <校区(GZIC 或 DXC)> [更新间隔]`
          );
          return;
        }

        // Parse parameters
        let startTime: Date | null = null;
        let endTime: Date | null = null;
        let lines = 'ewa'; // Default to showing all

        const timeParams: string[] = [];
        for (const param of params) {
          // Check if param is a line filter (only contains e, w, a, case-insensitive)
          if (/^[ewaEWA]+$/.test(param)) {
            lines = param;
          } else {
            timeParams.push(param);
          }
        }

        try {
          if (timeParams.length >= 1) {
            startTime = parseTimeParameter(timeParams[0]);
          }
          if (timeParams.length >= 2) {
            endTime = parseTimeParameter(timeParams[1]);
          }

          // Validation
          if (startTime && endTime && startTime >= endTime) {
            await send('错误：起始时间必须早于结束时间。');
            return;
          }
        } catch (error) {
          await send(`时间参数格式错误：${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        // Get bills with automatic token management
        const { electric, ac, water, room } = await this.getBillsWithTokenRefresh(qqId);
        db.updateLastLogin(qqId);

        // Get 24h change
        const change24h = db.getBilling24HourChange(qqId);

        // Get history for chart with custom time range
        let history;
        if (startTime || endTime) {
          history = db.getBillingHistoryByTimeRange(qqId, startTime, endTime);
        } else {
          // Default: last 7 days
          history = db.getBillingHistory(qqId, 7);
        }

        // Generate summary
        let messageText = `🏠 ${room}\n\n`;
        messageText += generateBillingSummary({ electric, water, ac }, change24h || undefined);

        // Build message segments
        const messageSegments: SendMessageSegment[] = [
          { type: 'text', data: { text: messageText } }
        ];

        // Add chart images if we have enough data
        if (history.length >= 2) {
          const chartData = history.reverse().map((h) => ({
            timestamp: h.recorded_at,
            electric: h.electric,
            water: h.water,
            ac: h.ac
          }));

          const requests = buildBillingChartRequests(chartData, room, lines);
          for (const request of requests) {
            try {
              const png = await this.deps.renderChart(request);
              const base64Image = `base64://${png.toString('base64')}`;
              messageSegments.push({ type: 'image', data: { file: base64Image } });
            } catch (error) {
              console.error('[Chart] Failed to render chart:', error);
            }
          }
        } else {
          (messageSegments[0] as { data: { text: string } }).data.text +=
            '\n💡 需要至少 2 条历史记录才能显示趋势图';
        }

        await send(messageSegments);
      } else if (subcommand === 'notify') {
        await this.handleNotifyCommand(command, params, qqId, context.message_type, chatId, send);
        this.emit('notifications-changed');
      } else if (subcommand === 'unnotify') {
        await this.handleUnnotifyCommand(qqId, context.message_type, chatId, send);
        this.emit('notifications-changed');
      } else if (subcommand === 'interval') {
        await this.handleIntervalCommand(command, params, qqId, send);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await send('操作失败，请稍后重试。').catch(() => undefined);
    }
  }
}
