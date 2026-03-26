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
  let laboralProductId: string | null = null;
  let festivoProductId: string | null = null;

  for (const p of allPackages) {
    if (p.scheduleKind === "FESTIVO") {
      festivoTotal += p.hoursTotal;
      festivoUsed += p.hoursUsed;
      if (!festivoProductId && p.productId) festivoProductId = p.productId;
    } else {
      laboralTotal += p.hoursTotal;
      laboralUsed += p.hoursUsed;
      if (!laboralProductId && p.productId) laboralProductId = p.productId;
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

  // Construir URLs de producto usando el handle (Shopify numeric ID → /products/<id>)
  // Si el productId es un GID como "gid://shopify/Product/123", extraemos el número.
  const extractProductNumericId = (gid: string) =>
    gid.includes("/") ? gid.split("/").pop() ?? gid : gid;

  const laboralProductUrl = laboralProductId
    ? `${storeUrl}/products/${extractProductNumericId(laboralProductId)}`
    : storeUrl;
  const festivoProductUrl = festivoProductId
    ? `${storeUrl}/products/${extractProductNumericId(festivoProductId)}`
    : storeUrl;

  // Logo local (servido desde `public/`) para evitar fallos de carga desde el CDN de Shopify.
  const logoUrl = "/logo-plancha-y-limpieza.svg";

  return {
    token,
    storeUrl,
    logoUrl,
    laboralProductUrl,
    festivoProductUrl,
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
    logoUrl,
    laboralProductUrl,
    festivoProductUrl,
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

  const isFestivo = selectedDayInfo?.type === "festivo";
  const accentColor = isFestivo ? "#c05c00" : "#008060";
  const accentBg = isFestivo ? "#fff4e5" : "#f0faf7";
  const accentBorder = isFestivo ? "#f4c07a" : "#b8e0d4";

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh", background: "#f7f8fa", color: "#1a1a1a" }}>

      {/* Top bar */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e8e8e8", padding: "0 24px" }}>
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "20px",
            minHeight: "72px",
            padding: "14px 0",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "20px",
              flex: "1 1 auto",
              minWidth: 0,
            }}
          >
            <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
              <img
                src={logoUrl}
                alt="Logo Plancha & Limpieza"
                style={{ height: "40px", width: "auto", maxWidth: "min(220px, 42vw)", objectFit: "contain", display: "block" }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            </div>
            <div
              aria-hidden
              style={{
                width: "1px",
                height: "40px",
                background: "#d9d9d9",
                flexShrink: 0,
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: 0, paddingLeft: "2px" }}>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: "16px",
                  lineHeight: 1.25,
                  letterSpacing: "-0.02em",
                  color: "#1a1a1a",
                }}
              >
                Bolsa de horas
              </div>
              {customer.name && (
                <div style={{ fontSize: "13px", color: "#6d7175", lineHeight: 1.3 }}>
                  {customer.name}
                </div>
              )}
            </div>
          </div>
          <a
            href={storeUrl}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              flexShrink: 0,
              padding: "10px 16px",
              background: "#f3f3f3",
              color: "#1a1a1a",
              borderRadius: "8px",
              textDecoration: "none",
              fontSize: "13px",
              fontWeight: 500,
              border: "1px solid #e0e0e0",
            }}
          >
            ← Volver a la tienda
          </a>
        </div>
      </div>

      <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "28px 24px" }}>

        {/* Aviso informativo */}
        <div style={{
          background: "#fffbf0", border: "1px solid #f4c07a", borderRadius: "10px",
          padding: "14px 18px", marginBottom: "24px",
          display: "flex", gap: "10px", alignItems: "flex-start", fontSize: "13px", color: "#7a4e00",
        }}>
          <span style={{ fontSize: "16px", flexShrink: 0 }}>ℹ️</span>
          <span>Para poblaciones de menos de 100.000 habitantes, requerimos un preaviso mínimo de 6 horas hábiles, con un plazo estándar de gestión de 48 horas hábiles.</span>
        </div>

        {allExpiredOrEmpty && (
          <div style={{
            background: "#fff", border: "1px solid #e8e8e8", borderRadius: "14px",
            padding: "24px", marginBottom: "24px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
          }}>
            <div style={{ display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ fontSize: "36px" }}>🛒</div>
              <div style={{ flex: 1, minWidth: "220px" }}>
                <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "6px" }}>
                  No tienes horas disponibles
                </div>
                <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "16px" }}>
                  Tus bolsas de horas están vacías o han expirado. Adquiere más horas para continuar agendando tus servicios.
                </div>
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <a
                    href={laboralProductUrl}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "6px",
                      padding: "9px 18px", background: "#008060", color: "#fff",
                      borderRadius: "8px", textDecoration: "none", fontSize: "13px", fontWeight: 600,
                    }}
                  >
                    💼 Comprar horas laborales
                  </a>
                  <a
                    href={festivoProductUrl}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "6px",
                      padding: "9px 18px", background: "#fff4e5", color: "#c05c00",
                      border: "1px solid #f4c07a", borderRadius: "8px",
                      textDecoration: "none", fontSize: "13px", fontWeight: 600,
                    }}
                  >
                    🎉 Comprar horas festivas
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tarjetas de resumen */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "28px" }}>
          {[
            {
              label: "Horas laborales",
              value: `${totals.laboralRemaining}h`,
              sub: `${totals.laboralUsed}h usadas de ${totals.laboralTotal}h`,
              accent: "#008060", bg: "#f0faf7", border: "#b8e0d4",
              icon: "💼",
            },
            {
              label: "Horas festivas",
              value: `${totals.festivoRemaining}h`,
              sub: `${totals.festivoUsed}h usadas de ${totals.festivoTotal}h`,
              accent: "#c05c00", bg: "#fff9f0", border: "#f4c07a",
              icon: "🎉",
            },
            {
              label: "Próxima expiración",
              value: allExpiredOrEmpty ? "—" : `${totals.daysUntilNextExpiry} días`,
              sub: "del paquete más próximo",
              accent: totals.daysUntilNextExpiry < 30 ? "#d72c0d" : "#3a3a3a",
              bg: "#f6f6f7", border: "#e0e0e0",
              icon: "📅",
            },
          ].map((stat) => (
            <div
              key={stat.label}
              style={{
                background: stat.bg, border: `1px solid ${stat.border}`,
                borderRadius: "12px", padding: "20px",
                display: "flex", flexDirection: "column", gap: "6px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "18px" }}>{stat.icon}</span>
                <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: 500 }}>{stat.label}</span>
              </div>
              <div style={{ fontSize: "30px", fontWeight: 800, color: stat.accent, lineHeight: 1 }}>{stat.value}</div>
              <div style={{ fontSize: "11px", color: "#8c9196" }}>{stat.sub}</div>
            </div>
          ))}
        </div>

        {!laboralConfig && (
          <div style={{ background: "#fff4e5", border: "1px solid #f4c07a", borderRadius: "10px", padding: "16px 18px", marginBottom: "24px" }}>
            La tienda aún no tiene horarios configurados. Contacta con nosotros para más información.
          </div>
        )}

        {laboralConfig && !allExpiredOrEmpty && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: "20px", alignItems: "start" }}>

            {/* ── Calendario ── */}
            <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: "16px", padding: "24px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>

              {/* Navegación mes */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
                <button
                  onClick={() => navigateMonth(-1)}
                  style={{ width: 36, height: 36, borderRadius: "8px", border: "1px solid #e0e0e0", background: "#fff", cursor: "pointer", fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  ‹
                </button>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontWeight: 700, fontSize: "18px" }}>{MONTH_NAMES[month]}</div>
                  <div style={{ fontSize: "12px", color: "#8c9196" }}>{year}</div>
                </div>
                <button
                  onClick={() => navigateMonth(1)}
                  style={{ width: 36, height: 36, borderRadius: "8px", border: "1px solid #e0e0e0", background: "#fff", cursor: "pointer", fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  ›
                </button>
              </div>

              {/* Leyenda */}
              <div style={{ display: "flex", gap: "14px", marginBottom: "16px", fontSize: "11px", color: "#6d7175", flexWrap: "wrap" }}>
                {[
                  { dot: "#008060", label: "Laboral" },
                  { dot: "#c05c00", label: "Festivo" },
                  { dot: "#e8a0a0", label: "Cerrado" },
                ].map((l) => (
                  <span key={l.label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: l.dot, display: "inline-block", flexShrink: 0 }} />
                    {l.label}
                  </span>
                ))}
              </div>

              {/* Cabecera días de la semana */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px", marginBottom: "4px" }}>
                {DAY_NAMES.map((n) => (
                  <div key={n} style={{ textAlign: "center", fontSize: "11px", fontWeight: 600, color: "#8c9196", padding: "4px 0", letterSpacing: "0.03em" }}>{n}</div>
                ))}
              </div>

              {/* Grid de días */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px" }}>
                {Array.from({ length: firstDayOffset }).map((_, i) => <div key={`e-${i}`} />)}
                {Array.from({ length: daysCount }, (_, i) => i + 1).map((day) => {
                  const info = getDayInfo(day);
                  const isSelected = selectedDay === info.isoDate;
                  const isToday = new Date(year, month, day).toDateString() === new Date().toDateString();
                  const agendable = dayIsAgendable(info);

                  // Colores base por tipo
                  let bg = "transparent", textColor = "#c0c0c0", cursor = "default";
                  let borderStyle = "2px solid transparent";
                  let dotColor = "";

                  if (info.type === "laboral") {
                    bg = agendable ? "#f0faf7" : "#f7fdf9";
                    textColor = "#1a1a1a";
                    cursor = "pointer"; // siempre clickable para mostrar CTA si no hay saldo
                    dotColor = "#008060";
                  } else if (info.type === "festivo") {
                    bg = agendable ? "#fff4e5" : "#fffaf4";
                    textColor = "#1a1a1a";
                    cursor = "pointer"; // siempre clickable para mostrar CTA si no hay saldo
                    dotColor = "#c05c00";
                  } else if (info.type === "bloqueado") {
                    bg = "#fce8e8";
                    textColor = "#c0a0a0";
                    cursor = "not-allowed";
                    dotColor = "#e8a0a0";
                  }

                  if (isSelected) {
                    bg = info.type === "festivo" ? "#ffe8c0" : "#c8e8da";
                    borderStyle = `2px solid ${info.type === "festivo" ? "#c05c00" : "#008060"}`;
                  } else if (isToday && (info.type === "laboral" || info.type === "festivo")) {
                    borderStyle = `2px solid ${info.type === "festivo" ? "#f4c07a" : "#b8e0d4"}`;
                  }

                  return (
                    <div
                      key={day}
                      onClick={() => {
                        // Días cerrados, pasados o bloqueados: ignorar click
                        if (info.type === "noDisponible" || info.type === "pasado" || info.type === "bloqueado") return;
                        // Días laborales/festivos sin saldo: seleccionar para mostrar CTA de compra
                        setSelectedDay(info.isoDate);
                        setShowForm(false);
                        setFormError("");
                      }}
                      style={{
                        position: "relative", aspectRatio: "1", borderRadius: "10px",
                        background: bg, border: borderStyle, cursor,
                        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                        gap: "2px", transition: "all 0.1s",
                      }}
                    >
                      <span style={{ fontSize: "13px", fontWeight: isToday ? 800 : 500, color: textColor, lineHeight: 1 }}>{day}</span>

                      {/* Dot indicador de tipo */}
                      {dotColor && (
                        <span style={{ width: 4, height: 4, borderRadius: "50%", background: dotColor, display: "block" }} />
                      )}

                      {/* "sin saldo" label */}
                      {(info.type === "laboral" || info.type === "festivo") && !agendable && (
                        <span style={{ fontSize: "7px", color: info.type === "festivo" ? "#c05c00" : "#008060", fontWeight: 700, letterSpacing: "0.02em", lineHeight: 1 }}>
                          sin saldo
                        </span>
                      )}

                      {/* Festivo label */}
                      {info.type === "festivo" && info.holiday && agendable && (
                        <span style={{ fontSize: "7px", color: "#c05c00", fontWeight: 600, lineHeight: 1 }}>
                          {info.holiday.priceExtra > 0 ? `+€${info.holiday.priceExtra}/h` : "festivo"}
                        </span>
                      )}

                      {/* Bloqueado */}
                      {info.type === "bloqueado" && (
                        <span style={{ fontSize: "9px", lineHeight: 1 }}>🔒</span>
                      )}

                      {/* Badge agendamientos */}
                      {info.slotsCount > 0 && (
                        <div style={{
                          position: "absolute", top: 3, right: 3,
                          background: "#008060", color: "#fff", borderRadius: "6px",
                          fontSize: "8px", padding: "1px 4px", fontWeight: 700, lineHeight: 1.4,
                        }}>
                          {info.slotsCount}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Panel lateral ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

              {!selectedDay ? (
                <div style={{
                  background: "#fff", border: "1px solid #e8e8e8", borderRadius: "16px",
                  padding: "32px 24px", textAlign: "center", color: "#8c9196",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                }}>
                  <div style={{ fontSize: "32px", marginBottom: "12px" }}>📅</div>
                  <div style={{ fontWeight: 600, fontSize: "14px", color: "#3a3a3a", marginBottom: "6px" }}>Selecciona un día</div>
                  <div style={{ fontSize: "13px" }}>Elige un día disponible en el calendario para ver opciones de agendamiento.</div>
                </div>
              ) : (
                <>
                  {/* Cabecera del día seleccionado */}
                  <div style={{
                    background: "#fff", border: "1px solid #e8e8e8", borderRadius: "16px",
                    padding: "18px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: "16px", fontWeight: 700 }}>{formatDate(selectedDay)}</div>
                        <div style={{ marginTop: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <span style={{
                            display: "inline-block", padding: "2px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600,
                            background: accentBg, color: accentColor, border: `1px solid ${accentBorder}`,
                          }}>
                            {isFestivo ? "🎉 Festivo" : "💼 Laboral"}
                          </span>
                          {selectedDayInfo?.type === "festivo" && selectedDayInfo.holiday && selectedDayInfo.holiday.priceExtra > 0 && (
                            <span style={{ fontSize: "11px", color: "#c05c00", fontWeight: 600 }}>
                              +€{selectedDayInfo.holiday.priceExtra.toFixed(2)}/h
                            </span>
                          )}
                        </div>
                      </div>
                      {selectedDayInfo && dayIsAgendable(selectedDayInfo) && availableHoursOnDay > 0 && !showForm && (
                        <button
                          onClick={() => setShowForm(true)}
                          style={{
                            background: "#008060", color: "#fff", border: "none", borderRadius: "8px",
                            padding: "8px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 600,
                            flexShrink: 0,
                          }}
                        >
                          + Agendar
                        </button>
                      )}
                    </div>

                  </div>

                  {/* Sin saldo → CTA de compra contextual (card independiente y prominente) */}
                  {selectedDayInfo && !dayIsAgendable(selectedDayInfo) &&
                    selectedDayInfo.type !== "pasado" && selectedDayInfo.type !== "bloqueado" && selectedDayInfo.type !== "noDisponible" && (
                    <div style={{
                      background: "#fff", border: `2px solid ${selectedDayInfo.type === "festivo" ? "#f4c07a" : "#b8e0d4"}`,
                      borderRadius: "16px", padding: "20px",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                    }}>
                      <div style={{ fontSize: "28px", marginBottom: "10px" }}>🛒</div>
                      <div style={{ fontWeight: 700, fontSize: "15px", marginBottom: "6px" }}>
                        {selectedDayInfo.type === "festivo"
                          ? "Necesitas horas festivas"
                          : "Necesitas horas laborales"}
                      </div>
                      <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "18px", lineHeight: 1.5 }}>
                        {selectedDayInfo.type === "festivo"
                          ? "Este día es festivo y no tienes horas festivas disponibles. Adquiérelas en la tienda y podrás agendar de inmediato."
                          : "No tienes horas laborales disponibles. Adquiérelas en la tienda y podrás agendar de inmediato."}
                      </div>
                      <a
                        href={selectedDayInfo.type === "festivo" ? festivoProductUrl : laboralProductUrl}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                          padding: "12px 20px", borderRadius: "10px", width: "100%", boxSizing: "border-box",
                          background: selectedDayInfo.type === "festivo" ? "#c05c00" : "#008060",
                          color: "#fff", textDecoration: "none", fontSize: "14px", fontWeight: 700,
                        }}
                      >
                        {selectedDayInfo.type === "festivo" ? "🎉 Comprar horas festivas" : "💼 Comprar horas laborales"}
                      </a>
                    </div>
                  )}

                  {/* Formulario de agendamiento */}
                  {showForm && (
                    <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: "16px", padding: "20px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                      <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "16px" }}>Nuevo agendamiento</div>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="create-slot" />
                        <input type="hidden" name="date" value={selectedDay} />
                        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                          {formError && (
                            <div style={{ background: "#fce8e8", border: "1px solid #e8b4b4", borderRadius: "8px", padding: "10px 14px", fontSize: "13px", color: "#d72c0d" }}>
                              {formError}
                            </div>
                          )}

                          <div>
                            <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "6px", color: "#3a3a3a" }}>Hora de inicio</label>
                            <select
                              name="startTime"
                              value={selectedTime}
                              onChange={(e) => { setSelectedTime(e.target.value); setSelectedHours(0); }}
                              required
                              style={{ width: "100%", padding: "9px 12px", borderRadius: "8px", border: "1px solid #d0d0d0", fontSize: "14px", background: "#fff" }}
                            >
                              <option value="">Seleccionar hora...</option>
                              {timeSlots.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>

                          <div>
                            <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "6px", color: "#3a3a3a" }}>
                              Horas a usar{" "}
                              <span style={{ fontWeight: 400, color: "#8c9196" }}>(disponibles: {kindAvailable}h · mínimo: {minHours}h)</span>
                            </label>
                            <select
                              name="hours"
                              value={selectedHours || ""}
                              onChange={(e) => setSelectedHours(parseInt(e.target.value))}
                              required
                              disabled={!selectedTime}
                              style={{ width: "100%", padding: "9px 12px", borderRadius: "8px", border: "1px solid #d0d0d0", fontSize: "14px", background: !selectedTime ? "#f5f5f5" : "#fff" }}
                            >
                              <option value="">Seleccionar horas...</option>
                              {availableHoursOnDay >= minHours
                                ? Array.from({ length: availableHoursOnDay - minHours + 1 }, (_, i) => i + minHours).map((h) => (
                                    <option key={h} value={h}>{h} hora{h > 1 ? "s" : ""}</option>
                                  ))
                                : null}
                            </select>
                            {selectedTime && availableHoursOnDay < minHours && (
                              <p style={{ color: "#d72c0d", fontSize: "12px", margin: "6px 0 0" }}>
                                No hay horas suficientes desde este horario para cubrir el mínimo de {minHours}h.
                              </p>
                            )}
                          </div>

                          <div>
                            <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "6px", color: "#3a3a3a" }}>Notas (opcional)</label>
                            <textarea
                              name="notes"
                              rows={2}
                              placeholder="Instrucciones especiales, dirección adicional..."
                              style={{ width: "100%", padding: "9px 12px", borderRadius: "8px", border: "1px solid #d0d0d0", fontSize: "14px", resize: "vertical", boxSizing: "border-box" }}
                            />
                          </div>

                          <div style={{ display: "flex", gap: "8px" }}>
                            <button
                              type="submit"
                              disabled={isSubmitting || !selectedTime || !selectedHours}
                              style={{
                                flex: 1, padding: "10px", borderRadius: "8px", border: "none", fontWeight: 700, fontSize: "14px", cursor: (isSubmitting || !selectedTime || !selectedHours) ? "default" : "pointer",
                                background: (isSubmitting || !selectedTime || !selectedHours) ? "#c5c5c5" : "#008060",
                                color: "#fff", transition: "background 0.15s",
                              }}
                            >
                              {isSubmitting ? "Guardando..." : "Confirmar agendamiento"}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setShowForm(false); setFormError(""); }}
                              style={{ padding: "10px 16px", borderRadius: "8px", border: "1px solid #d0d0d0", background: "#fff", cursor: "pointer", fontSize: "14px" }}
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      </fetcher.Form>
                    </div>
                  )}

                  {/* Agendamientos del día */}
                  <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: "16px", padding: "18px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                    <div style={{ fontWeight: 700, fontSize: "13px", color: "#3a3a3a", marginBottom: "12px" }}>
                      Agendamientos este día
                    </div>
                    {selectedDaySlots.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {selectedDaySlots.map((slot) => (
                          <div key={slot.id} style={{
                            background: "#f7f8fa", borderRadius: "10px", padding: "12px 14px",
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                          }}>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: "14px" }}>{slot.startTime} · {slot.hours}h</div>
                              {slot.notes && <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>{slot.notes}</div>}
                              <span style={{
                                display: "inline-block", marginTop: "4px", fontSize: "10px", fontWeight: 700,
                                padding: "2px 8px", borderRadius: "20px",
                                background: slot.scheduleKind === "FESTIVO" ? "#fff4e5" : "#f0faf7",
                                color: slot.scheduleKind === "FESTIVO" ? "#c05c00" : "#008060",
                              }}>
                                {slot.scheduleKind === "FESTIVO" ? "Festivo" : "Laboral"}
                              </span>
                            </div>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="cancel-slot" />
                              <input type="hidden" name="slotId" value={slot.id} />
                              <button type="submit" style={{
                                background: "none", border: "1px solid #e8a0a0", borderRadius: "6px",
                                color: "#d72c0d", cursor: "pointer", fontSize: "12px", padding: "4px 10px", fontWeight: 500,
                              }}>
                                Cancelar
                              </button>
                            </fetcher.Form>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p style={{ color: "#8c9196", fontSize: "13px", margin: 0 }}>Sin agendamientos para este día.</p>
                    )}
                  </div>
                </>
              )}

              {/* Historial completo */}
              {confirmedSlots.length > 0 && (
                <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: "16px", padding: "18px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                  <div style={{ fontWeight: 700, fontSize: "13px", color: "#3a3a3a", marginBottom: "12px" }}>
                    Todos mis agendamientos
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {confirmedSlots.map((s) => (
                      <div key={s.id} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", background: "#f7f8fa", borderRadius: "8px", fontSize: "13px",
                      }}>
                        <span>
                          <strong>{formatDate(s.date)}</strong>
                          <span style={{ color: "#6d7175" }}> · {s.startTime} · {s.hours}h</span>
                        </span>
                        <span style={{
                          fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "20px",
                          background: s.scheduleKind === "FESTIVO" ? "#fff4e5" : "#f0faf7",
                          color: s.scheduleKind === "FESTIVO" ? "#c05c00" : "#008060",
                        }}>
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
      </div>
    </div>
  );
}
