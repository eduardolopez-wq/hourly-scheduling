import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import crypto from "node:crypto";
import { inferHourScheduleKindFromLineItem } from "../schedule-kind";

type OrderLineItem = {
  id?: number;
  product_id: number | null;
  variant_id: number | null;
  title: string;
  variant_title?: string | null;
  quantity: number;
  properties: Array<{ name: string; value: string }>;
};

type OrderPayload = {
  id: number;
  name: string;
  email: string;
  customer?: {
    id: number;
    first_name?: string;
    last_name?: string;
  };
  line_items: OrderLineItem[];
  created_at: string;
};

/**
 * Webhook orders/paid:
 * Crea un HourPackage por cada línea de servicio con horas, con:
 * - scheduleKind LABORAL | FESTIVO según la variante (opción Horario)
 * - orderLineItemId para permitir varias líneas en el mismo pedido
 * - accessToken único por paquete (enlace al portal)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic, admin } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} para ${shop}`);

  const order = payload as OrderPayload;

  const serviceItems = order.line_items.filter((li) => {
    const hasSchedulingProp = li.properties?.some(
      (p) => p.name === "_scheduling_hours",
    );
    const titleMatch = /hora|limpieza|plancha|servicio/i.test(li.title);
    return hasSchedulingProp || titleMatch;
  });

  if (serviceItems.length === 0) {
    return new Response("No service items found", { status: 200 });
  }

  const orderId = String(order.id);

  const customerName = order.customer
    ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim()
    : "";
  const customerId = order.customer ? `gid://shopify/Customer/${order.customer.id}` : "";

  const shipping =
    (order as any).shipping_address ??
    (order as any).customer?.default_address ??
    null;
  const addressParts = [
    shipping?.address1,
    shipping?.address2,
    shipping?.city,
    shipping?.province,
    shipping?.zip,
    shipping?.country,
  ].filter((part) => !!part && part.trim().length > 0);
  const customerAddress = addressParts.join(", ");

  let customerTags = "";
  if (admin && order.customer?.id) {
    try {
      const gid = `gid://shopify/Customer/${order.customer.id}`;
      const response = await admin.graphql(
        `#graphql
        query getCustomerTags($id: ID!) {
          customer(id: $id) {
            tags
          }
        }`,
        { variables: { id: gid } },
      );
      const json = await response.json();
      const tags: string[] = json?.data?.customer?.tags ?? [];
      customerTags = tags.join(",");
    } catch (e) {
      console.error("[webhook] Error al obtener tags del cliente:", e);
    }
  }

  const purchasedAt = new Date(order.created_at);
  const expiresAt = new Date(purchasedAt);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  for (let idx = 0; idx < serviceItems.length; idx++) {
    const item = serviceItems[idx];
    const orderLineItemId = item.id != null ? String(item.id) : `fallback-${item.variant_id ?? "x"}-${idx}`;

    const existing = await prisma.hourPackage.findUnique({
      where: { shop_orderId_orderLineItemId: { shop, orderId, orderLineItemId } },
    });
    if (existing) continue;

    const hoursProp = item.properties?.find((p) => p.name === "_scheduling_hours")?.value;
    const hoursTotal = hoursProp
      ? Math.max(1, parseInt(String(hoursProp), 10) || item.quantity)
      : item.quantity;

    const productId = item.product_id ? `gid://shopify/Product/${item.product_id}` : "";
    const variantId = item.variant_id ? String(item.variant_id) : "";
    const scheduleKind = inferHourScheduleKindFromLineItem(item.title, item.variant_title);

    const accessToken = crypto.randomBytes(32).toString("hex");

    await prisma.hourPackage.create({
      data: {
        shop,
        orderId,
        orderLineItemId,
        orderName: order.name,
        productId,
        productTitle: item.title,
        variantId,
        scheduleKind,
        customerEmail: order.email,
        customerName,
        customerId,
        customerAddress,
        customerTags,
        hoursTotal,
        hoursUsed: 0,
        purchasedAt,
        expiresAt,
        accessToken,
      },
    });
  }

  console.log(
    `[webhook] HourPackage(s) para orden ${order.name} (${shop}) — cliente: ${order.email} — líneas: ${serviceItems.length}`,
  );

  return new Response(null, { status: 200 });
};
