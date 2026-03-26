/** Tipo de horas compradas (variante Shopify Horario). */
export type HourScheduleKind = "LABORAL" | "FESTIVO";

/** Clasificación del día en el calendario de agendamiento. */
export type CalendarDayKind = "LABORAL" | "FESTIVO" | "NO_DISPONIBLE" | "BLOQUEADO";

/** Tipos de día usados en la UI del portal / admin. */
export type PortalCalendarDayType =
  | "laboral"
  | "festivo"
  | "noDisponible"
  | "pasado"
  | "bloqueado";

export function inferHourScheduleKindFromLineItem(
  productTitle: string,
  variantTitle?: string | null,
): HourScheduleKind {
  const combined = `${variantTitle ?? ""} ${productTitle}`.toLowerCase();
  if (/\bfestiv(o|os)\b/i.test(combined)) return "FESTIVO";
  return "LABORAL";
}

export function packageMatchesCalendarDay(
  pkgKind: HourScheduleKind,
  dayKind: CalendarDayKind,
): boolean {
  if (dayKind === "BLOQUEADO" || dayKind === "NO_DISPONIBLE") return false;
  const required: HourScheduleKind = dayKind === "FESTIVO" ? "FESTIVO" : "LABORAL";
  return pkgKind === required;
}

export function portalDayTypeToCalendarKind(
  t: PortalCalendarDayType,
): CalendarDayKind | null {
  if (t === "bloqueado") return "BLOQUEADO";
  if (t === "noDisponible") return "NO_DISPONIBLE";
  if (t === "festivo") return "FESTIVO";
  if (t === "laboral") return "LABORAL";
  return null;
}

export function packageMatchesPortalCalendarDay(
  pkgKind: HourScheduleKind,
  dayType: PortalCalendarDayType,
): boolean {
  const k = portalDayTypeToCalendarKind(dayType);
  if (k == null) return false;
  return packageMatchesCalendarDay(pkgKind, k);
}
