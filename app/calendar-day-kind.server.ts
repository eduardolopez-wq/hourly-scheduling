import prisma from "./db.server";
import type { CalendarDayKind } from "./schedule-kind";

function dayOfWeekMonSunFromIso(iso: string): number {
  const [ys, ms, ds] = iso.split("-");
  const y = Number(ys);
  const m = Number(ms) - 1;
  const d = Number(ds);
  const dow = new Date(y, m, d).getDay();
  return dow === 0 ? 7 : dow;
}

export async function getCalendarDayKindForDate(
  shop: string,
  isoDate: string,
): Promise<CalendarDayKind> {
  const noon = new Date(`${isoDate}T12:00:00.000Z`);
  const [blocked, holiday, laboralConfig] = await Promise.all([
    prisma.blockedDay.findFirst({ where: { shop, date: noon } }),
    prisma.holiday.findFirst({ where: { shop, date: noon } }),
    prisma.scheduleConfig.findFirst({ where: { shop, scheduleType: "LABORAL" } }),
  ]);
  if (blocked) return "BLOQUEADO";
  if (holiday) return "FESTIVO";
  const workDays = laboralConfig?.workDays.split(",").map(Number) ?? [1, 2, 3, 4, 5];
  const dow = dayOfWeekMonSunFromIso(isoDate);
  if (workDays.includes(dow)) return "LABORAL";
  return "NO_DISPONIBLE";
}
