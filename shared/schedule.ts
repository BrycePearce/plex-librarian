export const DEFAULT_AUTO_SYNC_HOUR = 3;
export const DEFAULT_AUTO_SYNC_TIME_ZONE = 'UTC';

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
}

function formattedHour(formatter: Intl.DateTimeFormat, date: Date, timeZone: string): number {
  const hour = formatter.formatToParts(date).find((part) => part.type === 'hour')?.value;
  if (hour === undefined) throw new RangeError(`Could not resolve hour in ${timeZone}`);
  return Number(hour);
}

export function hourInTimeZone(date: Date, timeZone: string): number {
  return formattedHour(hourFormatter(timeZone), date, timeZone);
}

// Identifies a local scheduled hour without relying on its UTC offset. The two real
// instants that make up a daylight-saving fall-back hour intentionally share a key.
export function scheduleWindowKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day' | 'hour') =>
    parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = value('hour');
  if (!year || !month || !day || hour === undefined) {
    throw new RangeError(`Could not resolve schedule window in ${timeZone}`);
  }
  return `${timeZone}:${year}-${month}-${day}T${hour}`;
}

// Finds the next instant at which the scheduler is eligible to run in a local clock
// hour. If `now` is already inside that hour it is eligible immediately. Otherwise,
// scanning UTC hours handles daylight-saving transitions without fixed-offset
// arithmetic: a skipped local hour naturally resolves to the following day, while a
// repeated hour resolves to its first occurrence. Candidates advance by minutes rather
// than hours because several IANA zones have half-hour or quarter-hour UTC offsets.
export function nextScheduledInstant(
  now: Date,
  hour: number,
  timeZone: string,
): Date {
  const formatter = hourFormatter(timeZone);
  if (formattedHour(formatter, now, timeZone) === hour) return new Date(now);

  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let offset = 0; offset < 49 * 60; offset++) {
    if (formattedHour(formatter, candidate, timeZone) === hour) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new RangeError(`Could not find the next scheduled hour in ${timeZone}`);
}
