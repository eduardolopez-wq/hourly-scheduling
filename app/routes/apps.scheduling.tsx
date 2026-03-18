import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * App Proxy: /apps/scheduling
 *
 * Sirve datos al portal del cliente (página Liquid en el tema o Customer Account).
 * Shopify autentica las peticiones del proxy con firma HMAC.
 *
 * Endpoints:
 *   GET  /apps/scheduling?action=my-packages&email=<email>&page=&per_page=&sort=  → paquetes activos (paginado; sort: purchased_desc|purchased_asc|expires_asc|expires_desc)
 *   GET  /apps/scheduling?token=<accessToken>&action=package   → datos del paquete
 *   GET  /apps/scheduling?token=<accessToken>&action=slots     → slots agendados
 *   GET  /apps/scheduling?token=<accessToken>&action=available&year=&month=  → días/slots disponibles
 *   POST /apps/scheduling  body: { token, action: "create-slot", date, startTime, hours, notes }
 *   POST /apps/scheduling  body: { token, action: "cancel-slot", slotId }
 */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const portalMatch = pathname.match(/\/portal\/([^/?#]+)/);
  if (portalMatch) {
    const token = portalMatch[1];
    return redirect(`${url.origin}/portal/${token}`);
  }

  const { shop } = await authenticate.public.appProxy(request);
  const token = url.searchParams.get("token");
  const action = url.searchParams.get("action") ?? "package";

  // Endpoint especial: listar paquetes activos de un cliente por email (paginado y ordenable)
  if (action === "my-packages") {
    const email = url.searchParams.get("email");
    if (!email) return json({ error: "Email requerido" }, 400);

    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const perPage = Math.min(24, Math.max(6, parseInt(url.searchParams.get("per_page") ?? "12", 10)));
    const sortParam = url.searchParams.get("sort") ?? "purchased_desc";

    const now = new Date();
    const where = {
      shop,
      customerEmail: email.toLowerCase(),
      expiresAt: { gt: now },
    };

    type OrderOption = { purchasedAt?: "asc" | "desc"; expiresAt?: "asc" | "desc" };
    const orderMap: Record<string, OrderOption> = {
      purchased_desc: { purchasedAt: "desc" },
      purchased_asc: { purchasedAt: "asc" },
      expires_asc: { expiresAt: "asc" },
      expires_desc: { expiresAt: "desc" },
    };
    const orderBy = orderMap[sortParam] ?? orderMap.purchased_desc;

    const [packages, total, aggregates] = await Promise.all([
      prisma.hourPackage.findMany({
        where,
        orderBy,
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          orderName: true,
          productTitle: true,
          hoursTotal: true,
          hoursUsed: true,
          purchasedAt: true,
          expiresAt: true,
          accessToken: true,
        },
      }),
      prisma.hourPackage.count({ where }),
      prisma.hourPackage.groupBy({
        by: ["customerEmail"],
        where,
        _sum: { hoursTotal: true, hoursUsed: true },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / perPage));

    const agg = aggregates[0];
    const totalHoursPurchased = agg?._sum.hoursTotal ?? 0;
    const totalHoursUsed = agg?._sum.hoursUsed ?? 0;
    const totalHoursRemaining = totalHoursPurchased - totalHoursUsed;

    return json({
      packages: packages.map((p) => ({
        id: p.id,
        orderName: p.orderName,
        productTitle: p.productTitle,
        hoursTotal: p.hoursTotal,
        hoursUsed: p.hoursUsed,
        hoursRemaining: p.hoursTotal - p.hoursUsed,
        purchasedAt: p.purchasedAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
        accessToken: p.accessToken,
      })),
      total,
      page,
      perPage,
      totalPages,
      totalHoursPurchased,
      totalHoursUsed,
      totalHoursRemaining,
    });
  }

  if (!token) return json({ error: "Token requerido" }, 400);

  const pkg = await prisma.hourPackage.findFirst({
    where: { shop, accessToken: token },
    include: { slots: { orderBy: { date: "asc" } } },
  });

  if (!pkg) return json({ error: "Paquete no encontrado o token inválido" }, 404);

  const now = new Date();
  const isExpired = pkg.expiresAt < now;

  if (action === "package") {
    return json({
      id: pkg.id,
      orderName: pkg.orderName,
      productTitle: pkg.productTitle,
      customerName: pkg.customerName,
      hoursTotal: pkg.hoursTotal,
      hoursUsed: pkg.hoursUsed,
      hoursRemaining: pkg.hoursTotal - pkg.hoursUsed,
      purchasedAt: pkg.purchasedAt.toISOString(),
      expiresAt: pkg.expiresAt.toISOString(),
      isExpired,
    });
  }

  if (action === "slots") {
    return json({
      slots: pkg.slots
        .filter((s) => s.status === "CONFIRMED")
        .map((s) => ({
          id: s.id,
          date: s.date.toISOString().slice(0, 10),
          startTime: s.startTime,
          hours: s.hours,
          notes: s.notes,
          status: s.status,
        })),
    });
  }

  if (action === "available") {
    const year = parseInt(url.searchParams.get("year") ?? String(now.getFullYear()));
    const month = parseInt(url.searchParams.get("month") ?? String(now.getMonth()));

    const [laboralConfig, festivoConfig, holidays, existingSlots] = await Promise.all([
      prisma.scheduleConfig.findFirst({ where: { shop, scheduleType: "LABORAL" } }),
      prisma.scheduleConfig.findFirst({ where: { shop, scheduleType: "FESTIVO" } }),
      prisma.holiday.findMany({
        where: {
          shop,
          date: { gte: new Date(year, month, 1), lte: new Date(year, month + 1, 0, 23, 59, 59) },
        },
      }),
      prisma.bookingSlot.findMany({
        where: {
          shop,
          status: "CONFIRMED",
          date: { gte: new Date(year, month, 1), lte: new Date(year, month + 1, 0, 23, 59, 59) },
        },
      }),
    ]);

    if (!laboralConfig) return json({ error: "Horario no configurado" }, 404);

    const workDays = laboralConfig.workDays.split(",").map(Number);
    const daysCount = getDaysInMonth(year, month);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const availableDays = [];

    for (let day = 1; day <= daysCount; day++) {
      const date = new Date(year, month, day);
      if (date < today) continue; // no mostrar días pasados

      const dayOfWeek = date.getDay() === 0 ? 7 : date.getDay();
      const isoDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const holiday = holidays.find((h) => h.date.toISOString().slice(0, 10) === isoDate);

      let dayType: "laboral" | "festivo" | null = null;
      let config = laboralConfig;

      if (holiday) {
        dayType = "festivo";
        config = festivoConfig ?? laboralConfig;
      } else if (workDays.includes(dayOfWeek)) {
        dayType = "laboral";
      }

      if (!dayType) continue;

      const slots = generateTimeSlots(config.startHour, config.endHour, config.slotDuration);
      const occupiedSlots = existingSlots
        .filter((s) => s.date.toISOString().slice(0, 10) === isoDate)
        .map((s) => s.startTime);

      availableDays.push({
        date: isoDate,
        type: dayType,
        priceExtra: holiday?.priceExtra ?? 0,
        holidayDescription: holiday?.description ?? null,
        availableSlots: slots.filter((s) => !occupiedSlots.includes(s)),
      });
    }

    return json({ year, month, availableDays });
  }

  return json({ error: "Acción desconocida" }, 400);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.public.appProxy(request);
  const body = await request.json() as {
    token: string;
    action: string;
    date?: string;
    startTime?: string;
    hours?: number;
    notes?: string;
    slotId?: string;
  };

  const { token, action: act } = body;
  if (!token) return json({ error: "Token requerido" }, 400);

  const pkg = await prisma.hourPackage.findFirst({
    where: { shop, accessToken: token },
  });

  if (!pkg) return json({ error: "Paquete no encontrado" }, 404);

  const now = new Date();
  if (pkg.expiresAt < now) return json({ error: "El paquete ha expirado (1 año desde la compra)" }, 410);

  if (act === "create-slot") {
    const { date: rawDate, startTime, hours = 1, notes = "" } = body;
    if (!rawDate || !startTime) return json({ error: "Fecha y hora requeridas" }, 400);

    if (hours < 3) {
      return json({ error: "Cada servicio debe ser de al menos 3h.", }, 400);
    }

    const hoursRemaining = pkg.hoursTotal - pkg.hoursUsed;
    if (hoursRemaining < 3) {
      return json({
        error: `Para agendar necesitas al menos 3h disponibles en este paquete. Actualmente tienes ${hoursRemaining}h.`,
      }, 400);
    }

    if (hours > hoursRemaining) {
      return json({
        error: `Solo tienes ${hoursRemaining}h disponibles en este paquete`,
      }, 400);
    }

    const date = new Date(`${rawDate}T12:00:00.000Z`);

    const slot = await prisma.bookingSlot.create({
      data: {
        shop,
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

    // Disparar trigger de Shopify Flow para notificaciones
    try {
      await fetch(new URL("/api/flow-trigger", request.url).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotId: slot.id,
          shop,
          packageId: pkg.id,
          customerEmail: pkg.customerEmail,
          customerName: pkg.customerName,
          serviceDate: rawDate,
          startTime,
          hours: String(hours),
          orderName: pkg.orderName,
        }),
      });
    } catch {
      // No bloquear si Flow falla
    }

    return json({
      success: true,
      slot: {
        id: slot.id,
        date: rawDate,
        startTime: slot.startTime,
        hours: slot.hours,
      },
      hoursRemaining: hoursRemaining - hours,
    });
  }

  if (act === "cancel-slot") {
    const { slotId } = body;
    if (!slotId) return json({ error: "slotId requerido" }, 400);

    const slot = await prisma.bookingSlot.findFirst({
      where: { id: slotId, packageId: pkg.id },
    });

    if (!slot) return json({ error: "Slot no encontrado" }, 404);
    if (slot.status === "CANCELLED") return json({ error: "El slot ya está cancelado" }, 400);

    await prisma.bookingSlot.update({
      where: { id: slotId },
      data: { status: "CANCELLED" },
    });

    await prisma.hourPackage.update({
      where: { id: pkg.id },
      data: { hoursUsed: { decrement: slot.hours } },
    });

    return json({ success: true, hoursReturned: slot.hours });
  }

  return json({ error: "Acción desconocida" }, 400);
};
