export const DAY_START_HOUR = 4;

export function shiftHourToDayStart(hour: number, dayStartHour: number = DAY_START_HOUR) {
  const normalized = ((hour - dayStartHour) % 24 + 24) % 24;
  return normalized;
}

export function unshiftHourFromDayStart(shiftedHour: number, dayStartHour: number = DAY_START_HOUR) {
  return (shiftedHour + dayStartHour) % 24;
}

export function getLocalDayStartMs(referenceMs: number, dayStartHour: number = DAY_START_HOUR) {
  const date = new Date(referenceMs);
  if (date.getHours() < dayStartHour) {
    date.setDate(date.getDate() - 1);
  }
  date.setHours(dayStartHour, 0, 0, 0);
  return date.getTime();
}
