import { useState, useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import prisma from "../db.server";

export const meta: MetaFunction = () => [
  { title: "Bolsa de horas" },
];

// Ruta pública — no requiere autenticación de admin Shopify
// El acceso se controla con el accessToken único del paquete

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const token = params.token;
  if (!token) throw new Response("Token requerido", { status: 400 });

  const pkg = await prisma.hourPackage.findFirst({
    where: { accessToken: token },
    include: {
      slots: {
        where: { status: "CONFIRMED" },
        orderBy: { date: "asc" },
      },
    },
  });

  if (!pkg) throw new Response("Enlace no válido", { status: 404 });

  const url = new URL(request.url);
  const now = new Date();
  const year = parseInt(url.searchParams.get("year") ?? String(now.getFullYear()));
  const month = parseInt(url.searchParams.get("month") ?? String(now.getMonth()));

  const startOfMonth = new Date(year, month, 1);
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59);

  const [laboralConfig, festivoConfig, holidays] = await Promise.all([
    prisma.scheduleConfig.findFirst({ where: { shop: pkg.shop, scheduleType: "LABORAL" } }),
    prisma.scheduleConfig.findFirst({ where: { shop: pkg.shop, scheduleType: "FESTIVO" } }),
    prisma.holiday.findMany({
      where: { shop: pkg.shop, date: { gte: startOfMonth, lte: endOfMonth } },
    }),
  ]);

  const isExpired = pkg.expiresAt < now;
  const hoursRemaining = pkg.hoursTotal - pkg.hoursUsed;

  const activePackages = await prisma.hourPackage.findMany({
    where: {
      shop: pkg.shop,
      customerEmail: pkg.customerEmail.toLowerCase(),
      expiresAt: { gt: now },
    },
    select: {
      hoursTotal: true,
      hoursUsed: true,
    },
  });

  const globalTotalHours = activePackages.reduce((acc, p) => acc + p.hoursTotal, 0);
  const globalUsedHours = activePackages.reduce((acc, p) => acc + p.hoursUsed, 0);
  const globalRemainingHours = globalTotalHours - globalUsedHours;

  const storeUrl = pkg.shop.startsWith("http") ? pkg.shop : `https://${pkg.shop}`;

  return {
    token,
    storeUrl,
    pkg: {
      id: pkg.id,
      orderName: pkg.orderName,
      productTitle: pkg.productTitle,
      customerName: pkg.customerName,
      hoursTotal: pkg.hoursTotal,
      hoursUsed: pkg.hoursUsed,
      hoursRemaining,
      purchasedAt: pkg.purchasedAt.toISOString(),
      expiresAt: pkg.expiresAt.toISOString(),
      isExpired,
    },
    globalTotals: {
      totalHours: globalTotalHours,
      usedHours: globalUsedHours,
      remainingHours: globalRemainingHours,
    },
    confirmedSlots: pkg.slots.map((s) => ({
      id: s.id,
      date: s.date.toISOString().slice(0, 10),
      startTime: s.startTime,
      hours: s.hours,
      notes: s.notes,
    })),
    year,
    month,
    laboralConfig,
    festivoConfig,
    holidays: holidays.map((h) => ({
      id: h.id,
      date: h.date.toISOString().slice(0, 10),
      description: h.description,
      priceExtra: h.priceExtra,
    })),
  };
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const token = params.token;
  if (!token) return Response.json({ error: "Token requerido" }, { status: 400 });

  const pkg = await prisma.hourPackage.findFirst({ where: { accessToken: token } });
  if (!pkg) return Response.json({ error: "Paquete no encontrado" }, { status: 404 });

  const now = new Date();
  if (pkg.expiresAt < now) {
    return Response.json({ error: "El paquete ha expirado (1 año desde la compra)" }, { status: 410 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create-slot") {
    const rawDate = formData.get("date") as string;
    const startTime = formData.get("startTime") as string;
    const hours = parseInt(formData.get("hours") as string, 10);
    const notes = (formData.get("notes") as string) ?? "";

    if (!rawDate || !startTime || !hours) {
      return Response.json({ error: "Fecha, hora y horas son obligatorios" }, { status: 400 });
    }

    // Obtener la configuración de horario para validar mínimo de horas y rango horario
    const scheduleConfig = await prisma.scheduleConfig.findFirst({
      where: { shop: pkg.shop, scheduleType: "LABORAL" },
    });
    const minHours = scheduleConfig ? Math.round(scheduleConfig.slotDuration / 60) : 3;
    const startHour = scheduleConfig?.startHour ?? 8;
    const endHour = scheduleConfig?.endHour ?? 20;

    // Validar que la hora de inicio esté dentro del rango configurado
    const [reqHour, reqMin] = startTime.split(":").map(Number);
    if (reqHour < startHour || reqHour >= endHour) {
      return Response.json({
        error: `La hora de inicio debe estar entre ${String(startHour).padStart(2, "0")}:00 y ${String(endHour).padStart(2, "0")}:00.`,
      }, { status: 400 });
    }

    // Validar que el servicio no supere la hora de cierre
    const endOfService = reqHour + (reqMin / 60) + hours;
    if (endOfService > endHour) {
      return Response.json({
        error: `El servicio terminaría después de las ${String(endHour).padStart(2, "0")}:00 (hora de cierre).`,
      }, { status: 400 });
    }

    const hoursRemaining = pkg.hoursTotal - pkg.hoursUsed;

    if (hours < minHours) {
      return Response.json({
        error: `Cada servicio debe ser de al menos ${minHours} hora${minHours > 1 ? "s" : ""}.`,
      }, { status: 400 });
    }

    if (hoursRemaining < minHours) {
      return Response.json({
        error: `Para agendar necesitas al menos ${minHours}h disponibles en este paquete. Actualmente tienes ${hoursRemaining}h.`,
      }, { status: 400 });
    }

    if (hours > hoursRemaining) {
      return Response.json({
        error: `Solo tienes ${hoursRemaining}h disponibles en este paquete`,
      }, { status: 400 });
    }

    const date = new Date(`${rawDate}T12:00:00.000Z`);

    const slot = await prisma.bookingSlot.create({
      data: {
        shop: pkg.shop,
        packageId: pkg.id,
        date,
        startTime,
        hours,
        notes,
        status: "CONFIRMED",
      },
    });

    await prisma.hourPackage.update({
      where: { id: pkg.id },
      data: { hoursUsed: { increment: hours } },
    });

    // Disparar Flow para notificaciones
    try {
      const appUrl = process.env.SHOPIFY_APP_URL ?? "";
      if (appUrl) {
        await fetch(`${appUrl}/api/flow-trigger`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slotId: slot.id,
            shop: pkg.shop,
            packageId: pkg.id,
            customerEmail: pkg.customerEmail,
            customerName: pkg.customerName,
            serviceDate: rawDate,
            startTime,
            hours: String(hours),
            orderName: pkg.orderName,
          }),
        });
      }
    } catch {
      // No bloquear si Flow falla
    }

    return Response.json({ success: true });
  }

  if (intent === "cancel-slot") {
    const slotId = formData.get("slotId") as string;
    const slot = await prisma.bookingSlot.findFirst({
      where: { id: slotId, packageId: pkg.id },
    });

    if (!slot || slot.status === "CANCELLED") {
      return Response.json({ error: "Slot no válido" }, { status: 400 });
    }

    await prisma.bookingSlot.update({ where: { id: slotId }, data: { status: "CANCELLED" } });
    await prisma.hourPackage.update({
      where: { id: pkg.id },
      data: { hoursUsed: { decrement: slot.hours } },
    });

    return Response.json({ success: true });
  }

  return Response.json({ error: "Acción desconocida" }, { status: 400 });
};

// --- Helpers ---
function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1;
}

function generateTimeSlots(startHour: number, endHour: number, slotMinutes: number): string[] {
  const slots: string[] = [];
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += slotMinutes) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function formatDate(isoDate: string) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("es-ES", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

function daysUntilExpiry(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export default function SchedulingPortal() {
  const { token, storeUrl, pkg, confirmedSlots, year, month, laboralConfig, festivoConfig, holidays, globalTotals } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selectedTime, setSelectedTime] = useState("");
  const [selectedHours, setSelectedHours] = useState(0);
  const [formError, setFormError] = useState("");

  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (fetcher.data?.success) {
      setShowForm(false);
      setSelectedDay(null);
      setSelectedTime("");
      setSelectedHours(0);
      setFormError("");
    }
    if (fetcher.data?.error) {
      setFormError(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  const navigateMonth = (delta: number) => {
    let m = month + delta;
    let y = year;
    if (m > 11) { m = 0; y++; }
    if (m < 0) { m = 11; y--; }
    setSearchParams({ year: String(y), month: String(m) });
    setSelectedDay(null);
    setShowForm(false);
  };

  const daysCount = getDaysInMonth(year, month);
  const firstDayOffset = getFirstDayOfMonth(year, month);
  const workDays = laboralConfig?.workDays.split(",").map(Number) ?? [1, 2, 3, 4, 5];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  type DayInfo = {
    isoDate: string;
    type: "laboral" | "festivo" | "noDisponible" | "pasado";
    holiday?: { description: string; priceExtra: number };
    slotsCount: number;
  };

  const getDayInfo = (day: number): DayInfo => {
    const date = new Date(year, month, day);
    const isoDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayOfWeek = date.getDay() === 0 ? 7 : date.getDay();
    const holiday = holidays.find((h) => h.date === isoDate);
    const slotsCount = confirmedSlots.filter((s) => s.date === isoDate).length;

    if (date < today) return { isoDate, type: "pasado", slotsCount };
    if (holiday) return { isoDate, type: "festivo", holiday, slotsCount };
    if (workDays.includes(dayOfWeek)) return { isoDate, type: "laboral", slotsCount };
    return { isoDate, type: "noDisponible", slotsCount };
  };

  const selectedDayInfo = selectedDay
    ? getDayInfo(parseInt(selectedDay.split("-")[2]))
    : null;

  const activeConfig = selectedDayInfo?.type === "festivo" ? (festivoConfig ?? laboralConfig) : laboralConfig;
  // slotDuration en minutos → mínimo de horas requeridas (para las horas a usar)
  const minHours = activeConfig ? Math.round(activeConfig.slotDuration / 60) : 1;

  // Para las horas de inicio mostramos todas las horas enteras desde startHour hasta endHour (INCLUSIVO),
  // para que coincida 1:1 con lo configurado en el admin (independiente de la zona horaria).
  // Que el servicio quepa dentro del rango se valida en el servidor.
  const timeSlots = activeConfig
    ? Array.from(
        { length: activeConfig.endHour - activeConfig.startHour + 1 },
        (_, i) => {
          const hour = activeConfig.startHour + i;
          return `${String(hour).padStart(2, "0")}:00`;
        },
      )
    : [];

  const selectedDaySlots = selectedDay ? confirmedSlots.filter((s) => s.date === selectedDay) : [];

  // Calcular horas disponibles desde la hora de inicio seleccionada hasta el cierre del día
  const hoursOccupiedOnDay = selectedDaySlots.reduce((acc, s) => acc + s.hours, 0);
  const endHour = activeConfig?.endHour ?? 20;
  const startHourFromTime = selectedTime ? parseInt(selectedTime.split(":")[0], 10) : (activeConfig?.startHour ?? 8);
  const hoursUntilClose = endHour - startHourFromTime;
  const maxHoursFromTime = Math.max(0, hoursUntilClose - hoursOccupiedOnDay);
  const availableHoursOnDay = Math.min(pkg.hoursRemaining, maxHoursFromTime);

  const daysLeft = daysUntilExpiry(pkg.expiresAt);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: "960px", margin: "0 auto", padding: "24px 16px", color: "#1a1a1a" }}>

      {/* Cabecera con botón volver */}
      <div style={{ marginBottom: "24px", display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 4px" }}>
            Bolsa de horas
          </h1>
          <p style={{ color: "#6d7175", margin: 0 }}>
            {pkg.productTitle} · Orden {pkg.orderName}
          </p>
        </div>
        <a
          href={storeUrl}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px",
            padding: "10px 16px", background: "#1a1a1a", color: "#fff", borderRadius: "8px",
            textDecoration: "none", fontSize: "14px", fontWeight: 500,
          }}
        >
          ← Volver a la tienda
        </a>
      </div>

      {/* Alerta si expirado */}
      {pkg.isExpired && (
        <div style={{ background: "#fff4e5", border: "1px solid #f4c07a", borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
          <strong>⚠️ Este paquete ha expirado.</strong> Las horas no usadas han caducado (1 año desde la compra).
        </div>
      )}

      {/* Resumen global de bolsa de horas */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px", marginBottom: "28px" }}>
        {[
          { label: "Horas compradas (todas las bolsas)", value: `${globalTotals.totalHours}h`, color: "#1a1a1a" },
          { label: "Horas usadas (todas las bolsas)", value: `${globalTotals.usedHours}h`, color: "#1a1a1a" },
          {
            label: "Horas disponibles",
            value: `${globalTotals.remainingHours}h`,
            color: globalTotals.remainingHours === 0 ? "#d72c0d" : "#008060",
          },
          {
            label: "Vence",
            value: pkg.isExpired ? "Expirado" : `${daysLeft} días`,
            color: daysLeft < 30 ? "#c05c00" : "#1a1a1a",
          },
        ].map((stat) => (
          <div key={stat.label} style={{ background: "#f6f6f7", borderRadius: "8px", padding: "16px" }}>
            <div style={{ fontSize: "12px", color: "#6d7175", marginBottom: "4px" }}>{stat.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {!laboralConfig && (
        <div style={{ background: "#fff4e5", border: "1px solid #f4c07a", borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
          La tienda aún no tiene horarios configurados. Contacta con nosotros para más información.
        </div>
      )}

      {laboralConfig && !pkg.isExpired && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "24px" }}>

          {/* Calendario */}
          <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "10px", padding: "20px" }}>
            {/* Navegación */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <button
                onClick={() => navigateMonth(-1)}
                style={{ background: "none", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "6px 14px", cursor: "pointer" }}
              >
                ←
              </button>
              <strong style={{ fontSize: "16px" }}>{MONTH_NAMES[month]} {year}</strong>
              <button
                onClick={() => navigateMonth(1)}
                style={{ background: "none", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "6px 14px", cursor: "pointer" }}
              >
                →
              </button>
            </div>

            {/* Leyenda */}
            <div style={{ display: "flex", gap: "16px", marginBottom: "12px", fontSize: "12px", flexWrap: "wrap" }}>
              {[
                { color: "#f0faf7", border: "#b8e0d4", label: "Disponible" },
                { color: "#fff4e5", border: "#f4c07a", label: "Festivo" },
                { color: "#f0f0f0", border: "#ddd", label: "No disponible" },
              ].map((l) => (
                <span key={l.label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: l.color, border: `1px solid ${l.border}`, display: "inline-block" }} />
                  {l.label}
                </span>
              ))}
            </div>

            {/* Grid días */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "3px" }}>
              {DAY_NAMES.map((n) => (
                <div key={n} style={{ textAlign: "center", fontSize: "12px", fontWeight: 600, color: "#6d7175", padding: "6px 0" }}>{n}</div>
              ))}
              {Array.from({ length: firstDayOffset }).map((_, i) => <div key={`e-${i}`} />)}
              {Array.from({ length: daysCount }, (_, i) => i + 1).map((day) => {
                const info = getDayInfo(day);
                const isSelected = selectedDay === info.isoDate;
                const isToday = new Date(year, month, day).toDateString() === new Date().toDateString();

                let bg = "#f4f6f8", border = "1px solid transparent", color = "#aaa", cursor = "default";

                if (info.type === "laboral") { bg = "#f0faf7"; border = "1px solid #b8e0d4"; color = "#1a1a1a"; cursor = "pointer"; }
                else if (info.type === "festivo") { bg = "#fff4e5"; border = "1px solid #f4c07a"; color = "#1a1a1a"; cursor = "pointer"; }

                if (isSelected) { bg = info.type === "festivo" ? "#ffe8c0" : "#d4efe7"; border = "2px solid #008060"; }
                if (isToday && !isSelected) border = "2px solid #005c45";

                return (
                  <div
                    key={day}
                    onClick={() => {
                      if (info.type === "noDisponible" || info.type === "pasado") return;
                      setSelectedDay(info.isoDate);
                      setShowForm(false);
                      setFormError("");
                    }}
                    style={{ position: "relative", minHeight: "52px", padding: "6px", borderRadius: "6px", background: bg, border, cursor, transition: "all 0.12s" }}
                  >
                    <div style={{ fontSize: "13px", fontWeight: isToday ? 700 : 400, color }}>
                      {day}
                    </div>
                    {info.type === "festivo" && info.holiday && (
                      <div style={{ fontSize: "9px", color: "#c05c00", fontWeight: 600 }}>
                        {info.holiday.priceExtra > 0 ? `+€${info.holiday.priceExtra}/h` : "Festivo"}
                      </div>
                    )}
                    {info.slotsCount > 0 && (
                      <div style={{
                        position: "absolute", bottom: 3, right: 3,
                        background: "#008060", color: "#fff", borderRadius: "10px",
                        fontSize: "9px", padding: "1px 5px", fontWeight: 700,
                      }}>
                        {info.slotsCount}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Panel lateral */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {!selectedDay ? (
              <div style={{ background: "#f6f6f7", borderRadius: "10px", padding: "20px", color: "#6d7175" }}>
                Selecciona un día disponible del calendario para agendar horas.
              </div>
            ) : (
              <>
                {selectedDayInfo?.type === "festivo" && selectedDayInfo.holiday && selectedDayInfo.holiday.priceExtra > 0 && (
                  <div style={{ background: "#fff4e5", border: "1px solid #f4c07a", borderRadius: "8px", padding: "14px" }}>
                    <strong>Día festivo: {selectedDayInfo.holiday.description}</strong><br />
                    <span style={{ fontSize: "14px" }}>
                      Precio extra: <strong>+€{selectedDayInfo.holiday.priceExtra.toFixed(2)}/hora</strong>
                    </span>
                  </div>
                )}

                <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "10px", padding: "16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <strong>{formatDate(selectedDay)}</strong>
                    {pkg.hoursRemaining > 0 && availableHoursOnDay > 0 && !showForm && (
                      <button
                        onClick={() => setShowForm(true)}
                        style={{ background: "#008060", color: "#fff", border: "none", borderRadius: "6px", padding: "7px 14px", cursor: "pointer", fontSize: "13px" }}
                      >
                        + Agendar
                      </button>
                    )}
                  </div>

                  {showForm && (
                    <fetcher.Form method="post" style={{ marginBottom: "16px" }}>
                      <input type="hidden" name="intent" value="create-slot" />
                      <input type="hidden" name="date" value={selectedDay} />
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {formError && (
                          <div style={{ background: "#fce8e8", border: "1px solid #e8b4b4", borderRadius: "6px", padding: "10px", fontSize: "13px", color: "#d72c0d" }}>
                            {formError}
                          </div>
                        )}

                        <div>
                          <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                            Hora de inicio
                          </label>
                          <select
                            name="startTime"
                            value={selectedTime}
                            onChange={(e) => {
                              setSelectedTime(e.target.value);
                              setSelectedHours(0);
                            }}
                            required
                            style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #d0d0d0", fontSize: "14px" }}
                          >
                            <option value="">Seleccionar hora...</option>
                            {timeSlots.map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                            Horas a usar (disponibles: {globalTotals.remainingHours}h · mínimo: {minHours}h)
                          </label>
                          <select
                            name="hours"
                            value={selectedHours || ""}
                            onChange={(e) => setSelectedHours(parseInt(e.target.value))}
                            required
                            disabled={!selectedTime}
                            style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #d0d0d0", fontSize: "14px", background: !selectedTime ? "#f0f0f0" : undefined }}
                          >
                            <option value="">Seleccionar horas...</option>
                            {availableHoursOnDay >= minHours
                              ? Array.from(
                                  { length: availableHoursOnDay - minHours + 1 },
                                  (_, i) => i + minHours
                                ).map((h) => (
                                  <option key={h} value={h}>{h} hora{h > 1 ? "s" : ""}</option>
                                ))
                              : null}
                          </select>
                          {selectedTime && availableHoursOnDay < minHours && (
                            <p style={{ color: "#d72c0d", fontSize: "12px", margin: "4px 0 0" }}>
                              No hay suficientes horas disponibles desde este horario para cubrir el mínimo de {minHours}h.
                            </p>
                          )}
                        </div>

                        <div>
                          <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                            Notas (opcional)
                          </label>
                          <textarea
                            name="notes"
                            rows={2}
                            placeholder="Instrucciones especiales, dirección adicional..."
                            style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #d0d0d0", fontSize: "14px", resize: "vertical", boxSizing: "border-box" }}
                          />
                        </div>

                        <div style={{ display: "flex", gap: "8px" }}>
                          <button
                            type="submit"
                            disabled={isSubmitting || !selectedTime || !selectedHours}
                            style={{
                              background: (isSubmitting || !selectedTime || !selectedHours) ? "#aaa" : "#008060",
                              color: "#fff", border: "none", borderRadius: "6px",
                              padding: "9px 18px", cursor: (isSubmitting || !selectedTime || !selectedHours) ? "default" : "pointer",
                              fontSize: "14px", fontWeight: 600,
                            }}
                          >
                            {isSubmitting ? "Guardando..." : "Confirmar agendamiento"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setShowForm(false); setFormError(""); }}
                            style={{ background: "none", border: "1px solid #d0d0d0", borderRadius: "6px", padding: "9px 14px", cursor: "pointer", fontSize: "14px" }}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    </fetcher.Form>
                  )}

                  {selectedDaySlots.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {selectedDaySlots.map((slot) => (
                        <div key={slot.id} style={{ background: "#f6f6f7", borderRadius: "6px", padding: "10px 12px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <strong>{slot.startTime}</strong>
                              <span style={{ color: "#6d7175", marginLeft: "8px" }}>{slot.hours}h</span>
                            </div>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="cancel-slot" />
                              <input type="hidden" name="slotId" value={slot.id} />
                              <button
                                type="submit"
                                style={{ background: "none", border: "none", color: "#d72c0d", cursor: "pointer", fontSize: "12px" }}
                              >
                                Cancelar
                              </button>
                            </fetcher.Form>
                          </div>
                          {slot.notes && <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#6d7175" }}>{slot.notes}</p>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ color: "#6d7175", fontSize: "13px", margin: 0 }}>No hay agendamientos para este día.</p>
                  )}
                </div>
              </>
            )}

            {/* Todos los agendamientos confirmados */}
            {confirmedSlots.length > 0 && (
              <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "10px", padding: "16px" }}>
                <strong style={{ fontSize: "14px" }}>Mi bolsa de horas</strong>
                <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {confirmedSlots.map((s) => (
                    <div key={s.id} style={{ fontSize: "13px", padding: "8px", background: "#f6f6f7", borderRadius: "6px" }}>
                      <strong>{formatDate(s.date)}</strong> · {s.startTime} · {s.hours}h
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Botón volver al final */}
      <div style={{ marginTop: "32px", paddingTop: "24px", borderTop: "1px solid #e0e0e0", textAlign: "center" }}>
        <a
          href={storeUrl}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px",
            padding: "10px 20px", background: "#f6f6f7", color: "#1a1a1a", border: "1px solid #e0e0e0", borderRadius: "8px",
            textDecoration: "none", fontSize: "14px", fontWeight: 500,
          }}
        >
          ← Volver a la tienda
        </a>
      </div>
    </div>
  );
}
