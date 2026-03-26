import { useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCalendarDayKindForDate } from "../calendar-day-kind.server";
import {
  packageMatchesCalendarDay,
  packageMatchesPortalCalendarDay,
  type HourScheduleKind,
} from "../schedule-kind";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const now = new Date();
  const year = parseInt(url.searchParams.get("year") ?? String(now.getFullYear()));
  const month = parseInt(url.searchParams.get("month") ?? String(now.getMonth()));

  const startOfMonth = new Date(year, month, 1);
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59);

  const [laboralConfig, festivoConfig, holidays, slots, packages, blockedDays] = await Promise.all([
    prisma.scheduleConfig.findFirst({ where: { shop, scheduleType: "LABORAL" } }),
    prisma.scheduleConfig.findFirst({ where: { shop, scheduleType: "FESTIVO" } }),
    prisma.holiday.findMany({
      where: { shop, date: { gte: startOfMonth, lte: endOfMonth } },
    }),
    prisma.bookingSlot.findMany({
      where: { shop, status: "CONFIRMED", date: { gte: startOfMonth, lte: endOfMonth } },
      include: { package: true },
      orderBy: { date: "asc" },
    }),
    prisma.hourPackage.findMany({
      where: { shop },
      orderBy: { purchasedAt: "desc" },
      take: 50,
    }),
    prisma.blockedDay.findMany({
      where: { shop, date: { gte: startOfMonth, lte: endOfMonth } },
    }),
  ]);

  return {
    shop,
    year,
    month,
    laboralConfig,
    festivoConfig,
    holidays: holidays.map((h) => ({ ...h, date: h.date.toISOString(), createdAt: h.createdAt.toISOString() })),
    blockedDays: blockedDays.map((b) => ({ ...b, date: b.date.toISOString(), createdAt: b.createdAt.toISOString() })),
    slots: slots.map((s) => ({
      id: s.id,
      date: s.date.toISOString().slice(0, 10),
      startTime: s.startTime,
      hours: s.hours,
      notes: s.notes,
      status: s.status,
      packageId: s.packageId,
      customerName: s.package.customerName,
      customerEmail: s.package.customerEmail,
      productTitle: s.package.productTitle,
      orderName: s.package.orderName,
    })),
    packages: packages.map((p) => ({
      id: p.id,
      orderName: p.orderName,
      customerName: p.customerName,
      customerEmail: p.customerEmail,
      productTitle: p.productTitle,
      scheduleKind: p.scheduleKind as HourScheduleKind,
      hoursTotal: p.hoursTotal,
      hoursUsed: p.hoursUsed,
      hoursRemaining: p.hoursTotal - p.hoursUsed,
      expiresAt: p.expiresAt.toISOString(),
      accessToken: p.accessToken,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create-slot") {
    const packageId = formData.get("packageId") as string;
    const pkg = await prisma.hourPackage.findUnique({ where: { id: packageId } });
    if (!pkg) return { success: false, error: "Paquete no encontrado" };

    const hours = parseInt(formData.get("hours") as string, 10);
    if (hours > pkg.hoursTotal - pkg.hoursUsed) {
      return { success: false, error: "Horas insuficientes en el paquete" };
    }

    const rawDate = formData.get("date") as string;
    const dayKind = await getCalendarDayKindForDate(shop, rawDate);
    if (dayKind === "BLOQUEADO") {
      return { success: false, error: "Este día está bloqueado. Desbloquéalo en Configuración o elige otra fecha." };
    }
    if (dayKind === "NO_DISPONIBLE") {
      return { success: false, error: "Este día no es agendable en el calendario laboral." };
    }
    if (!packageMatchesCalendarDay(pkg.scheduleKind as HourScheduleKind, dayKind)) {
      return {
        success: false,
        error:
          dayKind === "FESTIVO"
            ? "Día festivo: solo paquetes con horas Festivas."
            : "Día laboral: solo paquetes con horas Laborales.",
      };
    }
    const slot = await prisma.bookingSlot.create({
      data: {
        shop,
        packageId,
        date: new Date(`${rawDate}T12:00:00.000Z`),
        startTime: formData.get("startTime") as string,
        hours,
        notes: (formData.get("notes") as string) ?? "",
        status: "CONFIRMED",
      },
    });

    await prisma.hourPackage.update({
      where: { id: packageId },
      data: { hoursUsed: { increment: hours } },
    });

    fetch(new URL("/api/flow-trigger", request.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotId: slot.id, shop }),
    }).catch(() => {});

    return { success: true, intent };
  }

  // Solo el backoffice puede editar/reagendar; el cliente no tiene esta acción (solo crear y cancelar).
  if (intent === "update-slot") {
    const slotId = formData.get("slotId") as string;
    const rawDate = formData.get("date") as string;
    const startTime = formData.get("startTime") as string;
    const hours = parseInt(formData.get("hours") as string, 10);
    const notes = (formData.get("notes") as string) ?? "";

    if (!slotId || !rawDate || !startTime || !hours) {
      return { success: false, error: "Faltan datos para actualizar el agendamiento" };
    }
    if (hours < 3) {
      return { success: false, error: "Cada servicio debe ser de al menos 3 horas" };
    }

    const slot = await prisma.bookingSlot.findUnique({
      where: { id: slotId },
      include: { package: true },
    });
    if (!slot || slot.status !== "CONFIRMED") {
      return { success: false, error: "Slot no encontrado" };
    }

    const pkg = slot.package;
    const hoursRemaining = pkg.hoursTotal - pkg.hoursUsed;
    const maxHoursForSlot = slot.hours + hoursRemaining;
    if (hours > maxHoursForSlot) {
      return {
        success: false,
        error: `El paquete solo permite hasta ${maxHoursForSlot}h para este agendamiento`,
      };
    }

    const newDate = new Date(`${rawDate}T12:00:00.000Z`);
    const newDayKind = await getCalendarDayKindForDate(shop, rawDate);
    if (newDayKind === "BLOQUEADO") {
      return { success: false, error: "No puedes mover el servicio a un día bloqueado." };
    }
    if (newDayKind === "NO_DISPONIBLE") {
      return { success: false, error: "La nueva fecha no es un día disponible en el calendario." };
    }
    if (!packageMatchesCalendarDay(pkg.scheduleKind as HourScheduleKind, newDayKind)) {
      return {
        success: false,
        error:
          newDayKind === "FESTIVO"
            ? "Esa fecha es festiva: el paquete del cliente es de horas laborales."
            : "Esa fecha es laboral: el paquete del cliente es de horas festivas.",
      };
    }

    const hoursDelta = hours - slot.hours;

    await prisma.bookingSlot.update({
      where: { id: slotId },
      data: {
        date: newDate,
        startTime,
        hours,
        notes,
      },
    });

    if (hoursDelta !== 0) {
      await prisma.hourPackage.update({
        where: { id: slot.packageId },
        data: { hoursUsed: { increment: hoursDelta } },
      });
    }

    fetch(new URL("/api/flow-trigger", request.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slotId,
        shop,
        serviceDate: rawDate,
        startTime,
        hours: String(hours),
      }),
    }).catch(() => {});

    return { success: true, intent };
  }

  if (intent === "cancel-slot") {
    const slotId = formData.get("slotId") as string;
    const slot = await prisma.bookingSlot.findUnique({ where: { id: slotId } });
    if (!slot) return { success: false, error: "Slot no encontrado" };

    await prisma.bookingSlot.update({ where: { id: slotId }, data: { status: "CANCELLED" } });
    await prisma.hourPackage.update({
      where: { id: slot.packageId },
      data: { hoursUsed: { decrement: slot.hours } },
    });

    return { success: true, intent };
  }

  return { success: false, intent };
};

// --- Helpers ---
function getDaysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); }
function getFirstDayOfMonth(y: number, m: number) { const d = new Date(y, m, 1).getDay(); return d === 0 ? 6 : d - 1; }
function generateTimeSlots(sh: number, eh: number, slot: number) {
  const slots: string[] = [];
  for (let h = sh; h < eh; h++)
    for (let m = 0; m < 60; m += slot)
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  return slots;
}

const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DAY_NAMES = ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"];

export default function Calendar() {
  const { shop, year, month, laboralConfig, festivoConfig, holidays, blockedDays, slots, packages } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [activeTab, setActiveTab] = useState<"calendar" | "packages">("calendar");
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (fetcher.data?.success) {
      if (fetcher.data.intent === "create-slot") {
        shopify.toast.show("Agendamiento creado");
        setShowForm(false);
        setSelectedDay(null);
      }
      if (fetcher.data.intent === "update-slot") {
        shopify.toast.show("Agendamiento actualizado. Se enviará confirmación al cliente.");
        setEditingSlotId(null);
      }
      if (fetcher.data.intent === "cancel-slot") {
        shopify.toast.show("Agendamiento cancelado");
      }
    }
    if (fetcher.data?.error && typeof fetcher.data.error === "string") {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const navigateMonth = (delta: number) => {
    let m = month + delta, y = year;
    if (m > 11) { m = 0; y++; } if (m < 0) { m = 11; y--; }
    setSearchParams({ year: String(y), month: String(m) });
    setSelectedDay(null); setShowForm(false); setEditingSlotId(null);
  };

  const daysCount = getDaysInMonth(year, month);
  const firstDayOffset = getFirstDayOfMonth(year, month);
  const workDays = laboralConfig?.workDays.split(",").map(Number) ?? [1, 2, 3, 4, 5];

  const getDayInfo = (day: number) => {
    const isoDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dow = new Date(year, month, day).getDay();
    const dayOfWeek = dow === 0 ? 7 : dow;
    const holiday = holidays.find((h) => h.date.startsWith(isoDate));
    const blocked = blockedDays.find((b) => b.date.startsWith(isoDate));
    const daySlots = slots.filter((s) => s.date === isoDate);
    let type: "laboral" | "festivo" | "noDisponible" | "bloqueado" = "noDisponible";
    if (blocked) type = "bloqueado";
    else if (holiday) type = "festivo";
    else if (workDays.includes(dayOfWeek)) type = "laboral";
    return { isoDate, type, holiday, blocked, slotsCount: daySlots.length };
  };

  const selectedIsoDate = selectedDay;
  const selectedDayInfo = selectedDay ? getDayInfo(parseInt(selectedDay.split("-")[2])) : null;
  const selectedDaySlots = selectedIsoDate ? slots.filter((s) => s.date === selectedIsoDate) : [];
  const activeConfig = selectedDayInfo?.type === "festivo" ? (festivoConfig ?? laboralConfig) : laboralConfig;
  const timeSlots = activeConfig ? generateTimeSlots(activeConfig.startHour, activeConfig.endHour, activeConfig.slotDuration) : [];

  const selectedPackage = packages.find((p) => p.id === selectedPackageId);
  const maxHoursAvailable = selectedPackage
    ? Math.min(selectedPackage.hoursRemaining, activeConfig ? activeConfig.endHour - activeConfig.startHour : 12)
    : 0;

  const portalBaseUrl = `https://${shop}/apps/scheduling/portal`;

  const tabStyle = (tab: typeof activeTab): React.CSSProperties => ({
    padding: "10px 20px", cursor: "pointer", border: "none",
    borderBottom: activeTab === tab ? "3px solid #008060" : "3px solid transparent",
    background: "none", fontWeight: activeTab === tab ? 600 : 400,
    color: activeTab === tab ? "#008060" : "#4a4a4a", fontSize: "14px",
  });

  return (
    <s-page heading="Calendario de Agendamientos">
      <div style={{ borderBottom: "1px solid #e0e0e0", marginBottom: "16px", display: "flex" }}>
        <button type="button" style={tabStyle("calendar")} onClick={() => setActiveTab("calendar")}>Calendario</button>
        <button type="button" style={tabStyle("packages")} onClick={() => setActiveTab("packages")}>
          Paquetes de horas ({packages.length})
        </button>
      </div>

      {activeTab === "calendar" && (
        <s-grid gridTemplateColumns="2fr 1fr" gap="base">
          <s-grid-item>
            <s-section>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-button variant="tertiary" onClick={() => navigateMonth(-1)}>← Anterior</s-button>
                <s-heading>{MONTH_NAMES[month]} {year}</s-heading>
                <s-button variant="tertiary" onClick={() => navigateMonth(1)}>Siguiente →</s-button>
              </s-stack>

              <s-box padding="base">
                <s-stack direction="inline" gap="base">
                  {[["#f0faf7","#b8e0d4","Laboral"],["#fff4e5","#f4c07a","Festivo"],["#f4f6f8","#e0e0e0","No disponible"],["#fce8e8","#e8a0a0","Bloqueado"]].map(([bg,bd,label]) => (
                    <s-stack key={label} direction="inline" gap="small" alignItems="center">
                      <span style={{ width: 12, height: 12, borderRadius: 3, background: bg, border: `1px solid ${bd}`, display: "inline-block" }} />
                      <s-text>{label}</s-text>
                    </s-stack>
                  ))}
                </s-stack>
              </s-box>

              <s-box padding="base">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "3px" }}>
                  {DAY_NAMES.map((n) => (
                    <div key={n} style={{ textAlign: "center", padding: "6px 0", fontWeight: 600, fontSize: "12px", color: "#6d7175" }}>{n}</div>
                  ))}
                  {Array.from({ length: firstDayOffset }).map((_, i) => <div key={`e-${i}`} />)}
                  {Array.from({ length: daysCount }, (_, i) => i + 1).map((day) => {
                    const info = getDayInfo(day);
                    const isSelected = selectedDay === info.isoDate;
                    const isToday = new Date(year, month, day).toDateString() === new Date().toDateString();
                    let bg = "#f4f6f8", border = "1px solid transparent", color = "#aaa", cursor = "pointer";
                    if (info.type === "laboral") { bg = "#f0faf7"; border = "1px solid #b8e0d4"; color = "#1a1a1a"; }
                    else if (info.type === "festivo") { bg = "#fff4e5"; border = "1px solid #f4c07a"; color = "#1a1a1a"; }
                    else if (info.type === "bloqueado") { bg = "#fce8e8"; border = "1px solid #e8a0a0"; color = "#8b0000"; }
                    if (isSelected) { bg = info.type === "festivo" ? "#ffe8c0" : info.type === "bloqueado" ? "#f5c6c6" : "#d4efe7"; border = `2px solid ${info.type === "bloqueado" ? "#c0392b" : "#008060"}`; }
                    if (isToday && !isSelected) border = "2px solid #005c45";
                    return (
                      <div key={day} onClick={() => { setSelectedDay(info.isoDate); setShowForm(false); setSelectedPackageId(""); setEditingSlotId(null); }}
                        style={{ position: "relative", minHeight: "58px", padding: "6px", borderRadius: "6px", background: bg, border, cursor, transition: "all 0.12s" }}>
                        <div style={{ fontSize: "13px", fontWeight: isToday ? 700 : 400, color }}>{day}</div>
                        {info.type === "festivo" && info.holiday && (
                          <div style={{ fontSize: "9px", color: "#c05c00", fontWeight: 600 }}>
                            {info.holiday.priceExtra > 0 ? `+€${info.holiday.priceExtra}/h` : "Festivo"}
                          </div>
                        )}
                        {info.type === "bloqueado" && (
                          <div style={{ fontSize: "9px", color: "#8b0000", fontWeight: 700 }}>🔒 Bloqueado</div>
                        )}
                        {info.slotsCount > 0 && (
                          <div style={{ position: "absolute", bottom: 3, right: 3, background: "#008060", color: "#fff", borderRadius: "10px", fontSize: "9px", padding: "1px 5px", fontWeight: 700 }}>
                            {info.slotsCount}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </s-box>
            </s-section>
          </s-grid-item>

          <s-grid-item>
            <s-stack direction="block" gap="base">
              {!selectedDay ? (
                <s-section heading="Selecciona un día">
                  <s-paragraph>Haz clic en cualquier día del calendario para ver y gestionar agendamientos (como administrador puedes elegir también días no disponibles).</s-paragraph>
                </s-section>
              ) : (
                <>
                  {selectedDayInfo?.type === "festivo" && selectedDayInfo.holiday && (
                    <s-banner tone="warning" heading={`Festivo: ${selectedDayInfo.holiday.description}`}>
                      {selectedDayInfo.holiday.priceExtra > 0 && (
                        <s-paragraph>Precio extra: <strong>€{selectedDayInfo.holiday.priceExtra.toFixed(2)}/hora</strong></s-paragraph>
                      )}
                    </s-banner>
                  )}

                  {selectedDayInfo?.type === "bloqueado" && (
                    <s-banner tone="critical" heading="Día bloqueado">
                      <s-paragraph>
                        Los clientes no pueden agendar este día.
                        {selectedDayInfo.blocked?.reason ? ` Motivo: ${selectedDayInfo.blocked.reason}` : ""}
                      </s-paragraph>
                    </s-banner>
                  )}

                  <s-section heading={selectedDay}>
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-badge tone={selectedDayInfo?.type === "bloqueado" ? "critical" : selectedDayInfo?.type === "festivo" ? "caution" : selectedDayInfo?.type === "laboral" ? "success" : "info"}>
                        {selectedDayInfo?.type === "bloqueado" ? "Bloqueado" : selectedDayInfo?.type === "festivo" ? "Festivo" : selectedDayInfo?.type === "laboral" ? "Laboral" : "No disponible"}
                      </s-badge>
                      {!showForm && selectedDayInfo?.type !== "bloqueado" && (
                        <s-button variant="primary" onClick={() => setShowForm(true)}>+ Agendar</s-button>
                      )}
                    </s-stack>
                  </s-section>

                  {showForm && (
                    <s-section heading="Nuevo agendamiento">
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="create-slot" />
                        <input type="hidden" name="date" value={selectedDay} />
                        <s-stack direction="block" gap="base">
                          <s-select
                            label="Paquete del cliente"
                            name="packageId"
                            value={selectedPackageId}
                            onChange={(e: Event) => setSelectedPackageId((e.target as HTMLSelectElement).value)}
                          >
                            <s-option value="">Seleccionar paquete...</s-option>
                            {packages.filter(
                              (p) =>
                                p.hoursRemaining > 0 &&
                                selectedDayInfo &&
                                packageMatchesPortalCalendarDay(p.scheduleKind, selectedDayInfo.type),
                            ).map((p) => (
                              <s-option key={p.id} value={p.id}>
                                {p.orderName} — {p.customerName || p.customerEmail} ({p.hoursRemaining}h ·{" "}
                                {p.scheduleKind === "FESTIVO" ? "Festivas" : "Laborales"})
                              </s-option>
                            ))}
                          </s-select>

                          {selectedDayInfo &&
                            showForm &&
                            !packages.some(
                              (p) =>
                                p.hoursRemaining > 0 &&
                                packageMatchesPortalCalendarDay(p.scheduleKind, selectedDayInfo.type),
                            ) && (
                            <s-banner tone="warning">
                              No hay paquetes con saldo para este tipo de día (
                              {selectedDayInfo.type === "festivo" ? "festivo — necesitas bolsa Festivas" : "laboral — necesitas bolsa Laborales"}
                              ).
                            </s-banner>
                          )}

                          {selectedPackage && (
                            <>
                              <s-select label="Hora de inicio" name="startTime">
                                <s-option value="">Seleccionar hora...</s-option>
                                {timeSlots.map((s) => <s-option key={s} value={s}>{s}</s-option>)}
                              </s-select>

                              <s-select label="Horas a asignar" name="hours">
                                {Array.from({ length: maxHoursAvailable }, (_, i) => i + 1).map((h) => (
                                  <s-option key={h} value={String(h)}>{h} hora{h > 1 ? "s" : ""}</s-option>
                                ))}
                              </s-select>

                              <s-text-area label="Notas (opcional)" name="notes" placeholder="Instrucciones especiales..." />
                            </>
                          )}

                          <s-stack direction="inline" gap="base">
                            <s-button type="submit" variant="primary" loading={fetcher.state !== "idle"}>Confirmar</s-button>
                            <s-button variant="secondary" onClick={() => setShowForm(false)}>Cancelar</s-button>
                          </s-stack>
                        </s-stack>
                      </fetcher.Form>
                    </s-section>
                  )}

                  <s-section heading={`Agendamientos (${selectedDaySlots.length})`}>
                    {selectedDaySlots.length === 0 ? (
                      <s-paragraph>No hay agendamientos para este día.</s-paragraph>
                    ) : (
                      <s-table>
                        <s-table-body>
                          {selectedDaySlots.map((slot) => {
                            const pkg = packages.find((p) => p.id === slot.packageId);
                            const hoursRemaining = pkg ? pkg.hoursTotal - pkg.hoursUsed : 0;
                            const maxHoursEdit = Math.max(3, slot.hours + hoursRemaining);
                            const isEditing = editingSlotId === slot.id;
                            return (
                              <s-table-row key={slot.id}>
                                <s-table-cell>
                                  {isEditing ? (
                                    <fetcher.Form method="post" id={`edit-slot-${slot.id}`}>
                                      <input type="hidden" name="intent" value="update-slot" />
                                      <input type="hidden" name="slotId" value={slot.id} />
                                      <s-stack direction="block" gap="base">
                                        <s-text>Cliente: {slot.customerName || slot.customerEmail}</s-text>
                                        <s-stack direction="block" gap="small">
                                          <s-stack direction="inline" gap="base">
                                            <label style={{ fontSize: "12px" }}>Fecha</label>
                                            <input type="date" name="date" defaultValue={slot.date} style={{ padding: "4px 8px" }} />
                                          </s-stack>
                                          <s-text color="subdued">Puedes elegir cualquier fecha para reagendar (incluso días no disponibles), según acuerdo con el cliente.</s-text>
                                        </s-stack>
                                        <s-select label="Hora de inicio" name="startTime" value={slot.startTime}>
                                          {timeSlots.map((t) => (
                                            <s-option key={t} value={t}>{t}</s-option>
                                          ))}
                                        </s-select>
                                        <s-select label="Horas" name="hours" value={String(slot.hours)}>
                                          {Array.from({ length: maxHoursEdit - 2 }, (_, i) => i + 3).map((h) => (
                                            <s-option key={h} value={String(h)}>{h}h</s-option>
                                          ))}
                                        </s-select>
                                        <s-text-area label="Notas" name="notes" defaultValue={slot.notes ?? ""} placeholder="Notas o confirmación para el cliente" />
                                        <s-stack direction="inline" gap="small">
                                          <s-button type="submit" variant="primary">Guardar y notificar</s-button>
                                          <s-button type="button" variant="secondary" onClick={() => setEditingSlotId(null)}>Cancelar</s-button>
                                        </s-stack>
                                      </s-stack>
                                    </fetcher.Form>
                                  ) : (
                                    <s-stack direction="block" gap="small">
                                      <s-text>{slot.startTime} · {slot.hours}h · {slot.customerName || slot.customerEmail}</s-text>
                                      <s-text color="subdued">{slot.productTitle} · {slot.orderName}</s-text>
                                      {slot.notes && <s-text color="subdued">{slot.notes}</s-text>}
                                    </s-stack>
                                  )}
                                </s-table-cell>
                                <s-table-cell>
                                  {!isEditing && (
                                    <s-stack direction="inline" gap="small">
                                      <s-button variant="secondary" onClick={() => setEditingSlotId(slot.id)}>Editar</s-button>
                                      <fetcher.Form method="post">
                                        <input type="hidden" name="intent" value="cancel-slot" />
                                        <input type="hidden" name="slotId" value={slot.id} />
                                        <s-button type="submit" variant="tertiary" tone="critical">Cancelar slot</s-button>
                                      </fetcher.Form>
                                    </s-stack>
                                  )}
                                </s-table-cell>
                              </s-table-row>
                            );
                          })}
                        </s-table-body>
                      </s-table>
                    )}
                  </s-section>
                </>
              )}
            </s-stack>
          </s-grid-item>
        </s-grid>
      )}

      {activeTab === "packages" && (
        <s-section heading="Paquetes de horas comprados">
          {packages.length === 0 ? (
            <s-paragraph>No hay paquetes registrados. Se crean automáticamente cuando un cliente paga una orden.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Orden</s-table-header>
                <s-table-header listSlot="labeled">Cliente</s-table-header>
                <s-table-header listSlot="labeled">Servicio</s-table-header>
                <s-table-header listSlot="labeled">Horas</s-table-header>
                <s-table-header listSlot="labeled">Vence</s-table-header>
                <s-table-header listSlot="inline">Portal cliente</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {packages.map((pkg) => {
                  const expiresDate = new Date(pkg.expiresAt);
                  const isExpired = expiresDate < new Date();
                  const daysLeft = Math.max(0, Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
                  return (
                    <s-table-row key={pkg.id}>
                      <s-table-cell>{pkg.orderName}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small">
                          <s-text>{pkg.customerName}</s-text>
                          <s-text color="subdued">{pkg.customerEmail}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{pkg.productTitle}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small">
                          <s-text>{pkg.hoursUsed}/{pkg.hoursTotal}h usadas</s-text>
                          <s-badge tone={pkg.hoursRemaining === 0 ? "neutral" : "success"}>
                            {pkg.hoursRemaining}h disponibles
                          </s-badge>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={isExpired ? "critical" : daysLeft < 30 ? "caution" : "neutral"}>
                          {isExpired ? "Expirado" : `${daysLeft} días`}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-button
                          href={`${portalBaseUrl}/${pkg.accessToken}`}
                          target="_blank"
                          variant="tertiary"
                        >
                          Administrar→
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
