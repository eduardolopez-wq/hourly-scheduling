import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [upcomingSlots, totalPackages, packagesWithHours, hasConfig] = await Promise.all([
    prisma.bookingSlot.findMany({
      where: { shop, status: "CONFIRMED", date: { gte: today } },
      include: { package: true },
      orderBy: { date: "asc" },
      take: 5,
    }),
    prisma.hourPackage.count({ where: { shop } }),
    prisma.hourPackage.findMany({
      where: { shop },
      select: { hoursTotal: true, hoursUsed: true },
    }),
    prisma.scheduleConfig.findFirst({ where: { shop } }),
  ]);

  const totalHoursPending = packagesWithHours.reduce(
    (acc, p) => acc + (p.hoursTotal - p.hoursUsed), 0,
  );

  return {
    upcomingSlots: upcomingSlots.map((s) => ({
      id: s.id,
      date: s.date.toISOString().slice(0, 10),
      startTime: s.startTime,
      hours: s.hours,
      customerName: s.package.customerName,
      customerEmail: s.package.customerEmail,
      productTitle: s.package.productTitle,
      orderName: s.package.orderName,
      customerAddress: s.package.customerAddress,
      isPrime: ((s.package as any).customerTags as string ?? "")
        .split(",")
        .map((t: string) => t.trim().toUpperCase())
        .includes("PRIME"),
    })),
    totalPackages,
    totalHoursPending,
    isConfigured: !!hasConfig,
  };
};

function formatDate(isoDate: string) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("es-ES", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export default function Index() {
  const { upcomingSlots, totalPackages, totalHoursPending, isConfigured } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Hourly Scheduling">
      {!isConfigured && (
        <s-banner slot="banner" tone="warning" heading="Configuración pendiente">
          <s-paragraph>
            Aún no has configurado los horarios de atención.{" "}
            <s-link href="/app/scheduling-config">Configura tus horarios ahora</s-link>{" "}
            para empezar a recibir agendamientos.
          </s-paragraph>
        </s-banner>
      )}

      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-grid-item>
          <s-stack direction="block" gap="base">
            <s-section heading="Resumen">
              <s-stack direction="inline" gap="base">
                <s-box padding="base" background="subdued">
                  <s-paragraph>Paquetes activos</s-paragraph>
                  <s-heading>{String(totalPackages)}</s-heading>
                </s-box>
                <s-box padding="base" background="subdued">
                  <s-paragraph>Horas por usar</s-paragraph>
                  <s-heading>{String(totalHoursPending)}h</s-heading>
                </s-box>
                <s-box padding="base" background="subdued">
                  <s-paragraph>Próximos servicios</s-paragraph>
                  <s-heading>{String(upcomingSlots.length)}</s-heading>
                </s-box>
              </s-stack>
            </s-section>

            <s-section heading="Próximos servicios agendados">
              {upcomingSlots.length === 0 ? (
                <s-paragraph>No hay servicios próximos agendados.</s-paragraph>
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Cliente</s-table-header>
                    <s-table-header listSlot="labeled">Servicio</s-table-header>
                    <s-table-header listSlot="labeled">Fecha del servicio</s-table-header>
                    <s-table-header listSlot="labeled">Dirección</s-table-header>
                    <s-table-header listSlot="inline">PRIME</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {upcomingSlots.map((slot) => (
                      <s-table-row key={slot.id}>
                        <s-table-cell>{slot.customerName || slot.customerEmail}</s-table-cell>
                        <s-table-cell>{slot.productTitle}</s-table-cell>
                        <s-table-cell>
                          {formatDate(slot.date)} · {slot.startTime} · {slot.hours}h
                        </s-table-cell>
                        <s-table-cell>{slot.customerAddress}</s-table-cell>
                        <s-table-cell>
                          {slot.isPrime ? (
                            <s-badge tone="success">PRIME</s-badge>
                          ) : (
                            <s-badge tone="neutral">—</s-badge>
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
              <s-box padding="base">
                <s-button href="/app/calendar" variant="tertiary">Ver calendario completo →</s-button>
              </s-box>
            </s-section>
          </s-stack>
        </s-grid-item>

        <s-grid-item>
          <s-stack direction="block" gap="base">
            <s-section heading="Acciones rápidas">
              <s-stack direction="block" gap="base">
                <s-button href="/app/calendar" variant="primary">Ver Calendario</s-button>
                <s-button href="/app/calendar?tab=packages" variant="secondary">Paquetes de horas</s-button>
                <s-button href="/app/scheduling-config" variant="secondary">Configurar Horarios</s-button>
              </s-stack>
            </s-section>

            <s-section heading="Flujo del cliente">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Cuando un cliente paga una orden, recibe automáticamente un enlace único para agendar sus horas de servicio.
                </s-paragraph>
                <s-unordered-list>
                  <s-list-item>El cliente compra las horas en la tienda</s-list-item>
                  <s-list-item>Recibe un email con enlace a su portal de agendamiento</s-list-item>
                  <s-list-item>Elige fecha y hora desde su portal</s-list-item>
                  <s-list-item>Recibe recordatorio 24h y 1h antes via Shopify Flow</s-list-item>
                  <s-list-item>Tiene 1 año para usar todas sus horas</s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-section>
          </s-stack>
        </s-grid-item>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
