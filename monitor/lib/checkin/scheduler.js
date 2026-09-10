/**
 * 每日定时签到调度器。
 * 按指定时区（IANA 名称）计算下一次签到时刻，避免依赖系统时区。
 */
export function parseTime(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!m) throw new Error(`无效时间格式: ${timeStr}，应为 HH:mm`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`无效时间: ${timeStr}`);
  return { hour, minute };
}

/**
 * 计算在指定时区下，下一次到达 HH:mm 的毫秒时间戳（Date.now() 之后）。
 */
export function nextTriggerMs(now = Date.now(), timeStr, timezone) {
  const { hour, minute } = parseTime(timeStr);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  function get(type) {
    return Number(parts.find((p) => p.type === type)?.value);
  }
  const year = get('year');
  const month = get('month');
  const day = get('day');

  // 计算目标时区墙上时间 (year-month-day hour:minute) 对应的 UTC 时间戳
  const offsetMs = getTimeZoneOffsetMs(now, timezone);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMs;

  if (targetUtc <= now) {
    // 已过当日签到点，取明天同一时刻
    return targetUtc + 24 * 3600 * 1000;
  }
  return targetUtc;
}

/** 计算某时刻在指定时区的 UTC 偏移（毫秒） */
function getTimeZoneOffsetMs(now, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });
  const parts = dtf.formatToParts(now);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+00:00';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(tz);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60) * 1000;
}

/**
 * 启动每日定时签到。
 * @returns {{stop: ()=>void, next: ()=>number}}
 */
export function startScheduler({ timeStr, timezone, onTick, now = Date.now }) {
  let timer = null;
  let stopped = false;

  function schedule() {
    const delay = nextTriggerMs(now(), timeStr, timezone) - now();
    timer = setTimeout(async () => {
      try {
        await onTick();
      } finally {
        if (!stopped) schedule();
      }
    }, Math.max(0, delay));
  }

  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get next() {
      return nextTriggerMs(now(), timeStr, timezone);
    },
  };
}