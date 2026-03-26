import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type ScheduleKindFilter = "ALL" | "LABORAL" | "FESTIVO";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const kind = (url.searchParams.get("kind") ?? "ALL") as ScheduleKindFilter;
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const perPage = 30;
  const skip = (page - 1) * perPage;

  // Evitamos tipado estricto del WhereInput para no acoplarnos al adapter actual.
  const where: any = { shop };

  if (kind !== "ALL") {
    where.scheduleKind = kind;
  }

  if (q) {
    where.OR = [
      { orderId: { contains: q } },
      { orderName: { contains: q } },
      { customerName: { contains: q } },
      { productTitle: { contains: q } },
    ];
  }

  const adminOrderBaseUrl = `https://${shop}/admin/orders`;

  const [packages, total] = await Promise.all([
    prisma.hourPackage.findMany({
      where,
      orderBy: { purchasedAt: "desc" },
      skip,
      take: perPage,
    }),
    prisma.hourPackage.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return {
    packages: packages.map((pkg) => ({
      id: pkg.id,
      orderId: pkg.orderId,
      orderName: pkg.orderName,
      orderUrl: `${adminOrderBaseUrl}/${pkg.orderId}`,
      customerName: pkg.customerName,
      customerEmail: pkg.customerEmail,
      productTitle: pkg.productTitle,
      scheduleKind: pkg.scheduleKind as "LABORAL" | "FESTIVO",
      hoursTotal: pkg.hoursTotal,
      purchasedAt: pkg.purchasedAt.toISOString(),
    })),
    q,
    kind,
    page,
    perPage,
    total,
    totalPages,
  };
};

export default function PackagesDetailsPage() {
  const { packages, q, kind, page, total, totalPages } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Detalle de órdenes de horas">
      <s-stack direction="block" gap="large">
        <s-section heading="Órdenes registradas">
          <s-paragraph>
            Aquí puedes revisar cada orden individual de horas compradas, filtrar por cliente o servicio y abrir el pedido
            directamente en Shopify Admin.
          </s-paragraph>
          <s-paragraph>{total} órdenes encontradas.</s-paragraph>
        </s-section>

        <s-section heading="Búsqueda y filtros">
          <form method="get">
            <s-stack direction="inline" gap="base">
              <s-text-field
                label="Buscar"
                name="q"
                value={q}
                placeholder="Orden, cliente, servicio..."
              />
              <s-select
                label="Tipo"
                name="kind"
                value={kind}
              >
                <s-option value="ALL">Todos</s-option>
                <s-option value="LABORAL">Laboral</s-option>
                <s-option value="FESTIVO">Festivo</s-option>
              </s-select>
              <s-button type="submit" variant="primary">Aplicar</s-button>
              {(q || kind !== "ALL") && (
                <s-button href="/app/packages" variant="tertiary">Limpiar</s-button>
              )}
            </s-stack>
          </form>
        </s-section>

        <s-section>
          {packages.length === 0 ? (
            <s-paragraph>No se encontraron órdenes con los filtros actuales.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Orden</s-table-header>
                <s-table-header listSlot="labeled">Cliente</s-table-header>
                <s-table-header listSlot="labeled">Servicio</s-table-header>
                <s-table-header listSlot="labeled">Tipo</s-table-header>
                <s-table-header listSlot="labeled">Horas adquiridas</s-table-header>
                <s-table-header listSlot="labeled">Compra</s-table-header>
                <s-table-header listSlot="inline">Pedido</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {packages.map((pkg) => (
                  <s-table-row key={pkg.id}>
                    <s-table-cell>{pkg.orderName || `#${pkg.orderId}`}</s-table-cell>
                    <s-table-cell>{pkg.customerName || pkg.customerEmail}</s-table-cell>
                    <s-table-cell>{pkg.productTitle}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={pkg.scheduleKind === "FESTIVO" ? "caution" : "success"}>
                        {pkg.scheduleKind === "FESTIVO" ? "Festivo" : "Laboral"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{pkg.hoursTotal}h</s-table-cell>
                    <s-table-cell>{new Date(pkg.purchasedAt).toLocaleDateString("es-ES")}</s-table-cell>
                    <s-table-cell>
                      <s-button href={pkg.orderUrl} target="_blank" variant="tertiary">Abrir pedido</s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          <div style={{ marginTop: 16 }}>
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-paragraph>Página {page} de {totalPages}</s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  href={`/app/packages?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}&page=${Math.max(1, page - 1)}`}
                  variant="tertiary"
                  disabled={page <= 1}
                >
                  ← Anterior
                </s-button>
                <s-button
                  href={`/app/packages?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}&page=${Math.min(totalPages, page + 1)}`}
                  variant="tertiary"
                  disabled={page >= totalPages}
                >
                  Siguiente →
                </s-button>
              </s-stack>
            </s-stack>
          </div>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

