import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const LIST_LIMIT = 500;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const adminOrderBaseUrl = `https://${shop}/admin/orders`;

  const [packages, total] = await Promise.all([
    prisma.hourPackage.findMany({
      where: { shop },
      orderBy: { purchasedAt: "desc" },
      take: LIST_LIMIT,
    }),
    prisma.hourPackage.count({ where: { shop } }),
  ]);

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
    total,
    listLimit: LIST_LIMIT,
  };
};

export default function PackagesDetailsPage() {
  const { packages, total, listLimit } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Detalle de órdenes de horas">
      <s-stack direction="block" gap="large">
        <s-section heading="Órdenes registradas">
          <s-paragraph>
            Aquí puedes revisar cada orden individual de horas compradas y abrir el pedido directamente en Shopify Admin.
          </s-paragraph>
          <s-paragraph>
            {total} órdenes registradas
            {total > listLimit ? ` (mostrando las ${listLimit} más recientes)` : "."}
          </s-paragraph>
        </s-section>

        <s-section>
          {packages.length === 0 ? (
            <s-paragraph>No hay órdenes registradas.</s-paragraph>
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
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
