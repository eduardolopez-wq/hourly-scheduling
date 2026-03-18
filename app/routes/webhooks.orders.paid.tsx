import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import crypto from "node:crypto";

type OrderLineItem = {
  product_id: number | null;
  variant_id: number | null;
  title: string;
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
 * Cuando un cliente paga una orden que contiene un producto de servicio por horas,
 * se crea un HourPackage con:
 * - Las horas totales = suma de quantity de todos los line items con propiedad "_scheduling_hours"
 * - expiresAt = purchasedAt + 1 año
 * - accessToken = token único para que el cliente acceda al portal de agendamiento
 *
 * Si el producto no tiene la propiedad "_scheduling_hours", se usa la quantity como horas.
 * Para marcar un producto como "servicio por horas", se usa la propiedad "_scheduling_hours"
 * en el line item (configurable desde el Theme App Extension o metafield del producto).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic, admin } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} para ${shop}`);

  const order = payload as OrderPayload;

  // Filtrar line items que son servicios de horas
  // Criterio: tienen la propiedad "_scheduling_hours" o el título contiene "hora" / "limpieza" / "plancha"
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
  const existing = await prisma.hourPackage.findUnique({
    where: { shop_orderId: { shop, orderId } },
  });

  if (existing) {
    return new Response("Already processed", { status: 200 });
  }

  const customerName = order.customer
    ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim()
    : "";
  const customerId = order.customer ? `gid://shopify/Customer/${order.customer.id}` : "";

  // Dirección de servicio: prioriza la dirección de envío del pedido
  // y, si no existe, cae a la dirección por defecto del cliente.
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

  // Consultar tags del cliente via Admin API GraphQL
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

  const accessToken = crypto.randomBytes(32).toString("hex");

  // Crear un HourPackage por cada line item de servicio
  for (const item of serviceItems) {
    const hoursTotal = item.quantity;
    const productId = item.product_id ? `gid://shopify/Product/${item.product_id}` : "";

    await prisma.hourPackage.create({
      data: {
        shop,
        orderId,
        orderName: order.name,
        productId,
        productTitle: item.title,
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
    `[webhook] HourPackage creado para orden ${order.name} (${shop}) — cliente: ${order.email} — tags: ${customerTags}`,
  );

  return new Response(null, { status: 200 });
};
