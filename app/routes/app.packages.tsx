import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const kind = url.searchParams.get("kind") ?? "ALL"; // ALL | LABORAL | FESTIVO
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));

  const perPage = 30;
  const skip = (page - 1) * perPage;

  // Evitamos tipado estricto del WhereInput para no acoplarnos a la variante del adapter (SQLite).
  const where: any = { shop };

  if (kind !== "ALL") where.scheduleKind = kind;

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
    packages: packages.map((p) => ({
      id: p.id,
      orderId: p.orderId,
      orderName: p.orderName,
      orderUrl: `${adminOrderBaseUrl}/${p.orderId}`,
      customerName: p.customerName,
      customerEmail: p.customerEmail,
      productTitle: p.productTitle,
      scheduleKind: p.scheduleKind,
      hoursTotal: p.hoursTotal,
      hoursUsed: p.hoursUsed,
      hoursRemaining: p.hoursTotal - p.hoursUsed,
      purchasedAt: p.purchasedAt.toISOString(),
    })),
    q,
    kind,
    page,
    perPage,
    total,
    totalPages,
  };
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function PackagesPage() {
  const {
    packages,
    q,
    kind,
    page,
    totalPages,
    total,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const applyPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(nextPage));
    setSearchParams(next);
  };

  return (
    <s-page heading="Detalle de órdenes de horas">
      <s-stack direction="block" gap="base">
        {(q || kind !== "ALL") && (
          <s-banner tone="info" heading="Filtros aplicados">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-paragraph>
                {total} resultados
                {q ? ` · "${q}"` : ""}
                {kind !== "ALL" ? ` · ${kind === "FESTIVO" ? "Festivo" : "Laboral"}` : ""}
              </s-paragraph>
              <s-button
                variant="tertiary"
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Limpiar filtros
              </s-button>
            </s-stack>
          </s-banner>
        )}

        <s-section heading="Órdenes registradas">
          <s-paragraph>
            Cada fila representa una línea de compra (orden / variante de producto).
            Las horas de cada orden se suman a la bolsa del cliente.
          </s-paragraph>
        </s-section>

        <s-section heading="Búsqueda y filtros">
          <form
            method="get"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 220px auto",
              gap: "12px",
              alignItems: "end",
            }}
          >
            <div>
              <label style={{ display: "block", fontSize: "12px", color: "#6d7175", marginBottom: "4px" }}>
                Buscar (orden, cliente o producto)
              </label>
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Ej: #1005, nombre del cliente, título del servicio..."
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "6px",
                  border: "1px solid #d0d0d0",
                  fontSize: "14px",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "12px", color: "#6d7175", marginBottom: "4px" }}>
                Tipo
              </label>
              <select
                name="kind"
                defaultValue={kind}
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "6px",
                  border: "1px solid #d0d0d0",
                  fontSize: "14px",
                }}
              >
                <option value="ALL">Todos</option>
                <option value="LABORAL">Laboral</option>
                <option value="FESTIVO">Festivo</option>
              </select>
            </div>

            <s-button type="submit" variant="primary">
              Aplicar
            </s-button>
            <input type="hidden" name="page" value="1" />
          </form>
        </s-section>

        {packages.length === 0 ? (
          <s-section>
            <s-paragraph>
              {q ? `No hay órdenes que coincidan con "${q}".` : "No hay órdenes registradas. Se crean automáticamente cuando un cliente paga una orden."}
            </s-paragraph>
          </s-section>
        ) : (
          <s-section>
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
                    <s-table-cell>{pkg.orderName}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small">
                        <s-text>{pkg.customerName || pkg.customerEmail}</s-text>
                        <s-text color="subdued">{pkg.customerEmail}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{pkg.productTitle}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={pkg.scheduleKind === "FESTIVO" ? "caution" : "success"}>
                        {pkg.scheduleKind === "FESTIVO" ? "Festivo" : "Laboral"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small">
                        <s-text>
                          {pkg.hoursTotal}h adquiridas
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{formatDate(pkg.purchasedAt)}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button href={pkg.orderUrl} target="_blank" variant="tertiary">
                        Ver pedido→
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            <div style={{ marginTop: 16 }}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text color="subdued">
                  Página {page} de {totalPages}
                </s-text>
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant="tertiary"
                    disabled={page <= 1}
                    onClick={() => applyPage(page - 1)}
                  >
                    ← Anterior
                  </s-button>
                  <s-button
                    variant="tertiary"
                    disabled={page >= totalPages}
                    onClick={() => applyPage(page + 1)}
                  >
                    Siguiente →
                  </s-button>
                </s-stack>
              </s-stack>
            </div>
          </s-section>
        )}

      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
