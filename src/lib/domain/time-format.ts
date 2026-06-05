const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const EMPTY_TIME = "未记录";

function dateParts(value: Date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(value);

  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])) as {
    year: string;
    month: string;
    day: string;
    hour: string;
    minute: string;
  };
}

function parseDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDisplayDateTime(value?: string, timeZone = DEFAULT_TIME_ZONE) {
  const date = parseDate(value);
  if (!date) return EMPTY_TIME;
  const parts = dateParts(date, timeZone);
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatDisplayTime(value?: string, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const date = parseDate(value);
  if (!date) return EMPTY_TIME;
  const target = dateParts(date, timeZone);
  const current = dateParts(now, timeZone);
  const isToday = target.year === current.year && target.month === current.month && target.day === current.day;
  return isToday ? `${target.hour}:${target.minute}` : `${target.month}-${target.day} ${target.hour}:${target.minute}`;
}
