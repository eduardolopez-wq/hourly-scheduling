import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Endpoint interno que dispara el trigger de Shopify Flow
 * "booking-confirmed" al crear un BookingSlot.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: {
    slotId?: string;
    packageId?: string;
    shop: string;
    customerEmail?: string;
    customerName?: string;
    serviceDate?: string;
    startTime?: string;
    hours?: string;
    orderName?: string;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { shop, slotId, packageId } = body;

  if (!shop) return Response.json({ error: "shop requerido" }, { status: 400 });

  let customerEmail = body.customerEmail ?? "";
  let customerName = body.customerName ?? "";
  let serviceDate = body.serviceDate ?? "";
  let startTime = body.startTime ?? "";
  let hours = body.hours ?? "";
  let orderName = body.orderName ?? "";

  // Si se pasa slotId, leer desde DB para tener datos completos
  if (slotId) {
    try {
      const slot = await prisma.bookingSlot.findUnique({
        where: { id: slotId },
        include: { package: true },
      });
      if (slot) {
        customerEmail = slot.package.customerEmail;
        customerName = slot.package.customerName;
        serviceDate = slot.date.toISOString().slice(0, 10);
        startTime = slot.startTime;
        hours = String(slot.hours);
        orderName = slot.package.orderName;
      }
    } catch {
      // usar los datos del body como fallback
    }
  }

  if (!customerEmail || !serviceDate || !startTime) {
    return Response.json({ error: "Datos insuficientes para disparar Flow" }, { status: 400 });
  }

  try {
    const { admin } = await authenticate.admin(request);

    const response = await admin.graphql(
      `#graphql
      mutation FlowTriggerReceive($handle: String!, $payload: JSON!) {
        flowTriggerReceive(handle: $handle, payload: $payload) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          handle: "booking-confirmed",
          payload: {
            booking_id: slotId ?? packageId ?? "",
            customer_email: customerEmail,
            customer_name: customerName,
            service_date: serviceDate,
            start_time: startTime,
            hours,
            order_id: packageId ?? "",
            order_name: orderName,
          },
        },
      },
    );

    const responseJson = await response.json();
    const userErrors = responseJson.data?.flowTriggerReceive?.userErrors ?? [];

    if (slotId) {
      await prisma.notificationLog.create({
        data: {
          slotId,
          type: "FLOW_TRIGGER",
          status: userErrors.length > 0 ? "FAILED" : "SENT",
          error: userErrors.length > 0
            ? userErrors.map((e: { message: string }) => e.message).join(", ")
            : null,
        },
      });
    }

    if (userErrors.length > 0) {
      return Response.json({ success: false, errors: userErrors }, { status: 422 });
    }

    return Response.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (slotId) {
      try {
        await prisma.notificationLog.create({
          data: { slotId, type: "FLOW_TRIGGER", status: "FAILED", error: errorMessage },
        });
      } catch { /* no bloquear */ }
    }

    return Response.json({ success: false, error: errorMessage }, { status: 500 });
  }
};
