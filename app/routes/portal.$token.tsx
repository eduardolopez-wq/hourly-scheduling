import { useState, useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import prisma from "../db.server";
import { getCalendarDayKindForDate } from "../calendar-day-kind.server";
import {
  packageMatchesCalendarDay,
  packageMatchesPortalCalendarDay,
  type HourScheduleKind,
  type PortalCalendarDayType,
} from "../schedule-kind";

export const meta: MetaFunction = () => [{ title: "Bolsa de horas" }];

// Ruta pública — acceso controlado por accessToken del paquete (cualquier paquete del cliente sirve como clave de entrada)

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const token = params.token;
  if (!token) throw new Response("Token requerido", { status: 400 });

  // El token puede ser de CUALQUIER paquete activo del cliente. Usamos el que corresponde
  // al token solo para identificar quién es el cliente y la tienda.
  const anchor = await prisma.hourPackage.findFirst({
    where: { accessToken: token },
  });
  if (!anchor) throw new Response("Enlace no válido", { status: 404 });

  const url = new URL(request.url);
  const now = new Date();
  const year = parseInt(url.searchParams.get("year") ?? String(now.getFullYear()));
  const month = parseInt(url.searchParams.get("month") ?? String(now.getMonth()));

  const startOfMonth = new Date(year, month, 1);
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59);

  // Cargar TODOS los paquetes activos del cliente (mismo email + misma tienda)
  const allPackages = await prisma.hourPackage.findMany({
    where: {
      shop: anchor.shop,
      customerEmail: anchor.customerEmail.toLowerCase(),
      expiresAt: { gt: now },
    },
    include: {
      slots: {
        where: { status: "CONFIRMED" },
        orderBy: { date: "asc" },
      },
    },
    orderBy: { expiresAt: "asc" }, // FIFO: los que vencen antes primero
  });

  const [laboralConfig, festivoConfig, holidays, blockedDays] = await Promise.all([
    prisma.scheduleConfig.findFirst({ where: { shop: anchor.shop, scheduleType: "LABORAL" } }),
    prisma.scheduleConfig.findFirst({ where: { shop: anchor.shop, scheduleType: "FESTIVO" } }),
    prisma.holiday.findMany({
      where: { shop: anchor.shop, date: { gte: startOfMonth, lte: endOfMonth } },
    }),
    prisma.blockedDay.findMany({
      where: { shop: anchor.shop, date: { gte: startOfMonth, lte: endOfMonth } },
    }),
  ]);

  let laboralTotal = 0, laboralUsed = 0;
  let festivoTotal = 0, festivoUsed = 0;

  for (const p of allPackages) {
    if (p.scheduleKind === "FESTIVO") {
      festivoTotal += p.hoursTotal;
      festivoUsed += p.hoursUsed;
    } else {
      laboralTotal += p.hoursTotal;
      laboralUsed += p.hoursUsed;
    }
  }

  const allConfirmedSlots = allPackages.flatMap((p) =>
    p.slots.map((s) => ({
      id: s.id,
      date: s.date.toISOString().slice(0, 10),
      startTime: s.startTime,
      hours: s.hours,
      notes: s.notes,
      scheduleKind: p.scheduleKind as HourScheduleKind,
    })),
  );

  // Vencimiento: el paquete más cercano a expirar con saldo
  const nextToExpire = allPackages.find((p) => p.hoursTotal - p.hoursUsed > 0) ?? allPackages[0];
  const daysUntilNextExpiry = nextToExpire
    ? Math.max(0, Math.ceil((nextToExpire.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  const storeUrl = anchor.shop.startsWith("http") ? anchor.shop : `https://${anchor.shop}`;

  return {
    token,
    storeUrl,
    customer: {
      name: anchor.customerName,
      email: anchor.customerEmail,
    },
    totals: {
      laboralTotal,
      laboralUsed,
      laboralRemaining: laboralTotal - laboralUsed,
      festivoTotal,
      festivoUsed,
      festivoRemaining: festivoTotal - festivoUsed,
      daysUntilNextExpiry,
      hasExpiredPackages: allPackages.length === 0,
    },
    confirmedSlots: allConfirmedSlots,
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
    blockedDays: blockedDays.map((b) => ({
      id: b.id,
      date: b.date.toISOString().slice(0, 10),
    })),
  };
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const token = params.token;
  if (!token) return Response.json({ error: "Token requerido" }, { status: 400 });

  const anchor = await prisma.hourPackage.findFirst({ where: { accessToken: token } });
  if (!anchor) return Response.json({ error: "Paquete no encontrado" }, { status: 404 });

  const now = new Date();
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

    const blockedDateCheck = new Date(`${rawDate}T12:00:00.000Z`);
    const blockedMatch = await prisma.blockedDay.findFirst({
      where: { shop: anchor.shop, date: blockedDateCheck },
    });
    if (blockedMatch) {
      return Response.json({
        error: "Este día no está disponible para agendar. Por favor elige otra fecha.",
      }, { status: 400 });
    }

    const dayKind = await getCalendarDayKindForDate(anchor.shop, rawDate);
    if (dayKind === "NO_DISPONIBLE") {
      return Response.json({
        error: "Este día no está disponible en el calendario (no laborable). Elige otro día.",
      }, { status: 400 });
    }

    const requiredKind: HourScheduleKind = dayKind === "FESTIVO" ? "FESTIVO" : "LABORAL";

    // Cargar paquetes del cliente del tipo correcto ordenados FIFO (vence antes primero)
    const candidatePackages = await prisma.hourPackage.findMany({
      where: {
        shop: anchor.shop,
        customerEmail: anchor.customerEmail.toLowerCase(),
        scheduleKind: requiredKind,
        expiresAt: { gt: now },
      },
      orderBy: { expiresAt: "asc" },
    });

    const totalAvailable = candidatePackages.reduce(
      (acc, p) => acc + (p.hoursTotal - p.hoursUsed),
      0,
    );

    if (totalAvailable === 0) {
      return Response.json({
        error:
          requiredKind === "FESTIVO"
            ? "No tienes horas festivas disponibles. Contacta con nosotros para comprar más."
            : "No tienes horas laborales disponibles. Contacta con nosotros para comprar más.",
      }, { status: 400 });
    }

    const [laboralConfig, festivoConfig] = await Promise.all([
      prisma.scheduleConfig.findFirst({ where: { shop: anchor.shop, scheduleType: "LABORAL" } }),
      prisma.scheduleConfig.findFirst({ where: { shop: anchor.shop, scheduleType: "FESTIVO" } }),
    ]);
    const scheduleConfig = dayKind === "FESTIVO" ? (festivoConfig ?? laboralConfig) : laboralConfig;
    const minHours = scheduleConfig ? Math.round(scheduleConfig.slotDuration / 60) : 3;
    const startHour = scheduleConfig?.startHour ?? 8;
    const endHour = scheduleConfig?.endHour ?? 20;

    const [reqHour, reqMin] = startTime.split(":").map(Number);
    if (reqHour < startHour || reqHour >= endHour) {
      return Response.json({
        error: `La hora de inicio debe estar entre ${String(startHour).padStart(2, "0")}:00 y ${String(endHour).padStart(2, "0")}:00.`,
      }, { status: 400 });
    }

    const endOfService = reqHour + reqMin / 60 + hours;
    if (endOfService > endHour) {
      return Response.json({
        error: `El servicio terminaría después de las ${String(endHour).padStart(2, "0")}:00 (hora de cierre).`,
      }, { status: 400 });
    }

    if (hours < minHours) {
      return Response.json({
        error: `Cada servicio debe ser de al menos ${minHours} hora${minHours > 1 ? "s" : ""}.`,
      }, { status: 400 });
    }

    if (hours > totalAvailable) {
      return Response.json({
        error: `Solo tienes ${totalAvailable}h ${requiredKind === "FESTIVO" ? "festivas" : "laborales"} disponibles.`,
      }, { status: 400 });
    }

    const date = new Date(`${rawDate}T12:00:00.000Z`);

    // FIFO: descontar del paquete que vence antes, encadenando si hace falta
    let toDeduct = hours;
    let slotId: string | null = null;

    for (const pkg of candidatePackages) {
      if (toDeduct <= 0) break;
      const available = pkg.hoursTotal - pkg.hoursUsed;
      if (available <= 0) continue;

      const deduct = Math.min(toDeduct, available);

      // El slot se crea en el primer paquete que tenga saldo
      if (!slotId) {
        const slot = await prisma.bookingSlot.create({
          data: {
            shop: anchor.shop,
            packageId: pkg.id,
            date,
            startTime,
            hours,
            notes,
            status: "CONFIRMED",
          },
        });
        slotId = slot.id;
      }

      await prisma.hourPackage.update({
        where: { id: pkg.id },
        data: { hoursUsed: { increment: deduct } },
      });

      toDeduct -= deduct;
    }

    if (slotId) {
      try {
        const appUrl = process.env.SHOPIFY_APP_URL ?? "";
        if (appUrl) {
          await fetch(`${appUrl}/api/flow-trigger`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slotId,
              shop: anchor.shop,
              packageId: candidatePackages[0].id,
              customerEmail: anchor.customerEmail,
              customerName: anchor.customerName,
              serviceDate: rawDate,
              startTime,
              hours: String(hours),
              orderName: anchor.orderName,
            }),
          });
        }
      } catch {
        // No bloquear si Flow falla
      }
    }

    return Response.json({ success: true });
  }

  if (intent === "cancel-slot") {
    const slotId = formData.get("slotId") as string;

    // Buscar entre todos los paquetes del cliente (no solo el del token)
    const slot = await prisma.bookingSlot.findFirst({
      where: {
        id: slotId,
        shop: anchor.shop,
        package: { customerEmail: anchor.customerEmail.toLowerCase() },
        status: "CONFIRMED",
      },
      include: { package: true },
    });

    if (!slot) {
      return Response.json({ error: "Agendamiento no encontrado o ya cancelado" }, { status: 400 });
    }

    await prisma.bookingSlot.update({ where: { id: slotId }, data: { status: "CANCELLED" } });
    await prisma.hourPackage.update({
      where: { id: slot.packageId },
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
const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
function formatDate(isoDate: string) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("es-ES", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

export default function SchedulingPortal() {
  const {
    token,
    storeUrl,
    customer,
    totals,
    confirmedSlots,
    year,
    month,
    laboralConfig,
    festivoConfig,
    holidays,
    blockedDays,
  } = useLoaderData<typeof loader>();

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
    type: PortalCalendarDayType;
    holiday?: { description: string; priceExtra: number };
    slotsCount: number;
  };

  const getDayInfo = (day: number): DayInfo => {
    const date = new Date(year, month, day);
    const isoDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayOfWeek = date.getDay() === 0 ? 7 : date.getDay();
    const holiday = holidays.find((h) => h.date === isoDate);
    const blocked = blockedDays.find((b) => b.date === isoDate);
    const slotsCount = confirmedSlots.filter((s) => s.date === isoDate).length;

    if (date < today) return { isoDate, type: "pasado", slotsCount };
    if (blocked) return { isoDate, type: "bloqueado", slotsCount };
    if (holiday) return { isoDate, type: "festivo", holiday, slotsCount };
    if (workDays.includes(dayOfWeek)) return { isoDate, type: "laboral", slotsCount };
    return { isoDate, type: "noDisponible", slotsCount };
  };

  const selectedDayInfo = selectedDay
    ? getDayInfo(parseInt(selectedDay.split("-")[2]))
    : null;

  // Un día es agendable si hay saldo del tipo requerido
  const dayIsAgendable = (info: DayInfo): boolean => {
    if (info.type === "laboral") return totals.laboralRemaining > 0;
    if (info.type === "festivo") return totals.festivoRemaining > 0;
    return false;
  };

  const activeConfig =
    selectedDayInfo?.type === "festivo" ? (festivoConfig ?? laboralConfig) : laboralConfig;
  const minHours = activeConfig ? Math.round(activeConfig.slotDuration / 60) : 1;

  const timeSlots = activeConfig
    ? Array.from(
        { length: activeConfig.endHour - activeConfig.startHour + 1 },
        (_, i) => `${String(activeConfig.startHour + i).padStart(2, "0")}:00`,
      )
    : [];

  const selectedDaySlots = selectedDay
    ? confirmedSlots.filter((s) => s.date === selectedDay)
    : [];

  const hoursOccupiedOnDay = selectedDaySlots.reduce((acc, s) => acc + s.hours, 0);
  const endHour = activeConfig?.endHour ?? 20;
  const startHourFromTime = selectedTime
    ? parseInt(selectedTime.split(":")[0], 10)
    : (activeConfig?.startHour ?? 8);
  const hoursUntilClose = endHour - startHourFromTime;
  const maxHoursFromTime = Math.max(0, hoursUntilClose - hoursOccupiedOnDay);

  // Disponibles = mínimo entre lo que queda hasta el cierre y el saldo del tipo correcto
  const kindAvailable =
    selectedDayInfo?.type === "festivo"
      ? totals.festivoRemaining
      : totals.laboralRemaining;
  const availableHoursOnDay = Math.min(kindAvailable, maxHoursFromTime);

  const allExpiredOrEmpty = totals.laboralRemaining === 0 && totals.festivoRemaining === 0;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: "960px", margin: "0 auto", padding: "24px 16px", color: "#1a1a1a" }}>

      {/* Cabecera */}
      <div style={{ marginBottom: "24px", display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 4px" }}>Bolsa de horas</h1>
          {customer.name && (
            <p style={{ color: "#6d7175", margin: 0, fontSize: "15px" }}>{customer.name}</p>
          )}
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

      {allExpiredOrEmpty && (
        <div style={{ background: "#fff4e5", border: "1px solid #f4c07a", borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
          <strong>⚠️ Sin horas disponibles.</strong> Tus bolsas de horas están vacías o han expirado.
          Contacta con nosotros para recargar.
        </div>
      )}

      {/* Resumen de horas */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px", marginBottom: "28px" }}>
        {[
          {
            label: "Horas laborales disponibles",
            value: `${totals.laboralRemaining}h`,
            sub: `${totals.laboralUsed}h usadas de ${totals.laboralTotal}h`,
            color: "#008060",
            bg: "#f0faf7",
            border: "#b8e0d4",
          },
          {
            label: "Horas festivas disponibles",
            value: `${totals.festivoRemaining}h`,
            sub: `${totals.festivoUsed}h usadas de ${totals.festivoTotal}h`,
            color: "#c05c00",
            bg: "#fff9f0",
            border: "#f4c07a",
          },
          {
            label: "Próxima expiración",
            value: allExpiredOrEmpty ? "—" : `${totals.daysUntilNextExpiry} días`,
            sub: "del paquete con saldo más antiguo",
            color: totals.daysUntilNextExpiry < 30 ? "#d72c0d" : "#1a1a1a",
            bg: "#f6f6f7",
            border: "#e0e0e0",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{ background: stat.bg, border: `1px solid ${stat.border}`, borderRadius: "8px", padding: "16px" }}
          >
            <div style={{ fontSize: "12px", color: "#6d7175", marginBottom: "4px" }}>{stat.label}</div>
            <div style={{ fontSize: "26px", fontWeight: 700, color: stat.color, lineHeight: 1.1 }}>{stat.value}</div>
            <div style={{ fontSize: "11px", color: "#8c9196", marginTop: "4px" }}>{stat.sub}</div>
          </div>
        ))}
      </div>

      {!laboralConfig && (
        <div style={{ background: "#fff4e5", border: "1px solid #f4c07a", borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
          La tienda aún no tiene horarios configurados. Contacta con nosotros para más información.
        </div>
      )}

      {laboralConfig && !allExpiredOrEmpty && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "24px" }}>

          {/* Calendario */}
          <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "10px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <button onClick={() => navigateMonth(-1)} style={{ background: "none", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "6px 14px", cursor: "pointer" }}>←</button>
              <strong style={{ fontSize: "16px" }}>{MONTH_NAMES[month]} {year}</strong>
              <button onClick={() => navigateMonth(1)} style={{ background: "none", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "6px 14px", cursor: "pointer" }}>→</button>
            </div>

            {/* Leyenda */}
            <div style={{ display: "flex", gap: "12px", marginBottom: "12px", fontSize: "11px", flexWrap: "wrap" }}>
              {[
                { color: "#f0faf7", border: "#b8e0d4", label: "Laboral disponible" },
                { color: "#fff4e5", border: "#f4c07a", label: "Festivo disponible" },
                { color: "#ececec", border: "#bbb", label: "Sin saldo del tipo" },
                { color: "#fce8e8", border: "#e8a0a0", label: "Cerrado / bloqueado" },
              ].map((l) => (
                <span key={l.label} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: l.color, border: `1px solid ${l.border}`, display: "inline-block" }} />
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
                const agendable = dayIsAgendable(info);

                let bg = "#f4f6f8", border = "1px solid transparent", color = "#aaa", cursor = "default";

                if (info.type === "laboral") {
                  if (agendable) { bg = "#f0faf7"; border = "1px solid #b8e0d4"; color = "#1a1a1a"; cursor = "pointer"; }
                  else { bg = "#ececec"; border = "1px solid #bbb"; color = "#888"; cursor = "not-allowed"; }
                } else if (info.type === "festivo") {
                  if (agendable) { bg = "#fff4e5"; border = "1px solid #f4c07a"; color = "#1a1a1a"; cursor = "pointer"; }
                  else { bg = "#ececec"; border = "1px solid #bbb"; color = "#888"; cursor = "not-allowed"; }
                } else if (info.type === "bloqueado") {
                  bg = "#fce8e8"; border = "1px solid #e8a0a0"; color = "#8b0000"; cursor = "not-allowed";
                }

                if (isSelected) { bg = info.type === "festivo" ? "#ffe8c0" : "#d4efe7"; border = "2px solid #008060"; }
                if (isToday && !isSelected) border = "2px solid #005c45";

                return (
                  <div
                    key={day}
                    onClick={() => {
                      if (info.type === "noDisponible" || info.type === "pasado" || info.type === "bloqueado") return;
                      if (!agendable) return;
                      setSelectedDay(info.isoDate);
                      setShowForm(false);
                      setFormError("");
                    }}
                    style={{ position: "relative", minHeight: "52px", padding: "6px", borderRadius: "6px", background: bg, border, cursor, transition: "all 0.12s" }}
                  >
                    <div style={{ fontSize: "13px", fontWeight: isToday ? 700 : 400, color }}>{day}</div>
                    {info.type === "festivo" && info.holiday && (
                      <div style={{ fontSize: "9px", color: "#c05c00", fontWeight: 600 }}>
                        {info.holiday.priceExtra > 0 ? `+€${info.holiday.priceExtra}/h` : "Festivo"}
                      </div>
                    )}
                    {info.type === "bloqueado" && (
                      <div style={{ fontSize: "9px", color: "#8b0000", fontWeight: 700 }}>🔒</div>
                    )}
                    {(info.type === "laboral" || info.type === "festivo") && !agendable && (
                      <div style={{ fontSize: "8px", color: "#888" }}>sin saldo</div>
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

                {selectedDayInfo && !dayIsAgendable(selectedDayInfo) &&
                  selectedDayInfo.type !== "pasado" && selectedDayInfo.type !== "bloqueado" && selectedDayInfo.type !== "noDisponible" && (
                  <div style={{ background: "#fff4e5", border: "1px solid #e8a0a0", borderRadius: "8px", padding: "14px", fontSize: "14px" }}>
                    <strong>Sin saldo disponible para este tipo de día.</strong><br />
                    {selectedDayInfo.type === "laboral"
                      ? "No tienes horas laborales. Contacta para recargar tu bolsa."
                      : "No tienes horas festivas. Contacta para recargar tu bolsa."}
                  </div>
                )}

                <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "10px", padding: "16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <div>
                      <strong>{formatDate(selectedDay)}</strong>
                      <span style={{ display: "block", fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                        {selectedDayInfo?.type === "festivo" ? "Día festivo · horas festivas" : "Día laboral · horas laborales"}
                      </span>
                    </div>
                    {selectedDayInfo && dayIsAgendable(selectedDayInfo) && availableHoursOnDay > 0 && !showForm && (
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
                          <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "4px" }}>Hora de inicio</label>
                          <select
                            name="startTime"
                            value={selectedTime}
                            onChange={(e) => { setSelectedTime(e.target.value); setSelectedHours(0); }}
                            required
                            style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #d0d0d0", fontSize: "14px" }}
                          >
                            <option value="">Seleccionar hora...</option>
                            {timeSlots.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
                            Horas a usar (disponibles: {kindAvailable}h · mínimo: {minHours}h)
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
                              ? Array.from({ length: availableHoursOnDay - minHours + 1 }, (_, i) => i + minHours).map((h) => (
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
                          <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "4px" }}>Notas (opcional)</label>
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
                              <span style={{ marginLeft: "8px", fontSize: "11px", color: slot.scheduleKind === "FESTIVO" ? "#c05c00" : "#008060", fontWeight: 600 }}>
                                {slot.scheduleKind === "FESTIVO" ? "Festivo" : "Laboral"}
                              </span>
                            </div>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="cancel-slot" />
                              <input type="hidden" name="slotId" value={slot.id} />
                              <button type="submit" style={{ background: "none", border: "none", color: "#d72c0d", cursor: "pointer", fontSize: "12px" }}>
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

            {/* Historial de agendamientos confirmados */}
            {confirmedSlots.length > 0 && (
              <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "10px", padding: "16px" }}>
                <strong style={{ fontSize: "14px" }}>Mis agendamientos confirmados</strong>
                <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {confirmedSlots.map((s) => (
                    <div key={s.id} style={{ fontSize: "13px", padding: "8px", background: "#f6f6f7", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>
                        <strong>{formatDate(s.date)}</strong> · {s.startTime} · {s.hours}h
                      </span>
                      <span style={{ fontSize: "11px", fontWeight: 600, color: s.scheduleKind === "FESTIVO" ? "#c05c00" : "#008060" }}>
                        {s.scheduleKind === "FESTIVO" ? "Festivo" : "Laboral"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
