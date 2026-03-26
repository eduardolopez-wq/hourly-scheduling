import { useState } from "react";
import type React from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [laboralConfig, festivoConfig, holidays, blockedDays] = await Promise.all([
    prisma.scheduleConfig.findFirst({ where: { shop, scheduleType: "LABORAL" } }),
    prisma.scheduleConfig.findFirst({ where: { shop, scheduleType: "FESTIVO" } }),
    prisma.holiday.findMany({ where: { shop }, orderBy: { date: "asc" } }),
    prisma.blockedDay.findMany({ where: { shop }, orderBy: { date: "asc" } }),
  ]);

  return {
    laboralConfig,
    festivoConfig,
    holidays: holidays.map((h) => ({
      ...h,
      date: h.date.toISOString(),
      createdAt: h.createdAt.toISOString(),
    })),
    blockedDays: blockedDays.map((b) => ({
      ...b,
      date: b.date.toISOString(),
      createdAt: b.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save-laboral") {
    const startHour = parseInt(formData.get("startHour") as string, 10);
    const endHour = parseInt(formData.get("endHour") as string, 10);
    const slotDuration = parseInt(formData.get("slotDuration") as string, 10);
    const workDays = formData.getAll("workDays").join(",");

    await prisma.scheduleConfig.upsert({
      where: { shop_scheduleType: { shop, scheduleType: "LABORAL" } },
      create: { shop, scheduleType: "LABORAL", startHour, endHour, slotDuration, workDays },
      update: { startHour, endHour, slotDuration, workDays },
    });
    return { success: true, intent };
  }

  if (intent === "save-festivo") {
    const startHour = parseInt(formData.get("startHour") as string, 10);
    const endHour = parseInt(formData.get("endHour") as string, 10);

    // La duración del slot se hereda de la configuración laboral
    const laboralConfig = await prisma.scheduleConfig.findFirst({
      where: { shop, scheduleType: "LABORAL" },
    });
    const slotDuration = laboralConfig?.slotDuration ?? 60;

    await prisma.scheduleConfig.upsert({
      where: { shop_scheduleType: { shop, scheduleType: "FESTIVO" } },
      create: { shop, scheduleType: "FESTIVO", startHour, endHour, slotDuration },
      update: { startHour, endHour, slotDuration },
    });
    return { success: true, intent };
  }

  if (intent === "add-holiday") {
    const rawDate = formData.get("date") as string; // "YYYY-MM-DD"
    // Forzar mediodía UTC para evitar desfases de zona horaria al guardar/leer
    const date = new Date(`${rawDate}T12:00:00.000Z`);
    const description = formData.get("description") as string;
    const priceExtra = parseFloat(formData.get("priceExtra") as string) || 0;

    await prisma.holiday.upsert({
      where: { shop_date: { shop, date } },
      create: { shop, date, description, priceExtra },
      update: { description, priceExtra },
    });
    return { success: true, intent };
  }

  if (intent === "delete-holiday") {
    const id = formData.get("id") as string;
    await prisma.holiday.delete({ where: { id } });
    return { success: true, intent };
  }

  if (intent === "add-blocked-day") {
    const rawDate = formData.get("date") as string;
    const reason = (formData.get("reason") as string) ?? "";
    const date = new Date(`${rawDate}T12:00:00.000Z`);

    await prisma.blockedDay.upsert({
      where: { shop_date: { shop, date } },
      create: { shop, date, reason },
      update: { reason },
    });
    return { success: true, intent };
  }

  if (intent === "delete-blocked-day") {
    const id = formData.get("id") as string;
    await prisma.blockedDay.delete({ where: { id } });
    return { success: true, intent };
  }

  return { success: false, intent };
};

const DAYS_OF_WEEK = [
  { value: "1", label: "Lunes" },
  { value: "2", label: "Martes" },
  { value: "3", label: "Miércoles" },
  { value: "4", label: "Jueves" },
  { value: "5", label: "Viernes" },
  { value: "6", label: "Sábado" },
  { value: "7", label: "Domingo" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: `${String(i).padStart(2, "0")}:00`,
}));

const SLOT_DURATIONS = [
  { value: "60", label: "1 hora" },
  { value: "120", label: "2 horas" },
  { value: "180", label: "3 horas" },
];

function formatHolidayDate(isoString: string) {
  // Extraer YYYY-MM-DD de la ISO string y construir fecha al mediodía UTC
  // para evitar desfases de zona horaria al formatear
  const datePart = isoString.slice(0, 10); // "YYYY-MM-DD"
  const date = new Date(`${datePart}T12:00:00.000Z`);
  return date.toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function SchedulingConfig() {
  const { laboralConfig, festivoConfig, holidays, blockedDays } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  const [activeTab, setActiveTab] = useState<"laboral" | "festivo" | "notifications">("laboral");
  const [newHolidayDate, setNewHolidayDate] = useState("");
  const [newHolidayDesc, setNewHolidayDesc] = useState("");
  const [newHolidayPrice, setNewHolidayPrice] = useState("0");
  const [newBlockedDate, setNewBlockedDate] = useState("");
  const [newBlockedReason, setNewBlockedReason] = useState("");

  const selectedWorkDays = laboralConfig?.workDays?.split(",") ?? ["1", "2", "3", "4", "5"];
  const isSubmitting = fetcher.state !== "idle";

  if (fetcher.data?.success && fetcher.state === "idle") {
    const messages: Record<string, string> = {
      "save-laboral": "Horario laboral guardado",
      "save-festivo": "Horario festivo guardado",
      "add-holiday": "Día festivo agregado",
      "delete-holiday": "Día festivo eliminado",
      "add-blocked-day": "Día bloqueado correctamente",
      "delete-blocked-day": "Bloqueo eliminado",
    };
    if (fetcher.data.intent && messages[fetcher.data.intent]) {
      shopify.toast.show(messages[fetcher.data.intent]);
    }
  }

  const tabStyle = (tab: "laboral" | "festivo" | "notifications"): React.CSSProperties => ({
    padding: "10px 20px",
    cursor: "pointer",
    border: "none",
    borderBottom: activeTab === tab ? "3px solid #008060" : "3px solid transparent",
    background: "none",
    fontWeight: activeTab === tab ? 600 : 400,
    color: activeTab === tab ? "#008060" : "#4a4a4a",
    fontSize: "14px",
  });

  return (
    <s-page heading="Configuración de Horarios">
      <div style={{ borderBottom: "1px solid #e0e0e0", marginBottom: "16px", display: "flex", gap: "0" }}>
        <button type="button" style={tabStyle("laboral")} onClick={() => setActiveTab("laboral")}>
          Horario Laboral
        </button>
        <button type="button" style={tabStyle("festivo")} onClick={() => setActiveTab("festivo")}>
          Horario Festivo &amp; Días Festivos
        </button>
        <button type="button" style={tabStyle("notifications")} onClick={() => setActiveTab("notifications")}>
          Notificaciones
        </button>
      </div>

      {activeTab === "laboral" && (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="save-laboral" />
          <s-grid gridTemplateColumns="2fr 1fr" gap="base">
            <s-grid-item>
              <s-section heading="Días y horas de atención laboral">
                <s-stack direction="block" gap="base">
                  <s-stack direction="block" gap="small">
                    <s-text>Días laborales</s-text>
                    <s-stack direction="inline" gap="base">
                      {DAYS_OF_WEEK.map((day) => (
                        <label key={day.value} style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            name="workDays"
                            value={day.value}
                            defaultChecked={selectedWorkDays.includes(day.value)}
                          />
                          {day.label}
                        </label>
                      ))}
                    </s-stack>
                  </s-stack>

                  <s-stack direction="inline" gap="base">
                    <s-select
                      label="Hora de inicio"
                      name="startHour"
                      value={String(laboralConfig?.startHour ?? 8)}
                    >
                      {HOURS.map((h) => (
                        <s-option key={h.value} value={h.value}>{h.label}</s-option>
                      ))}
                    </s-select>

                    <s-select
                      label="Hora de fin"
                      name="endHour"
                      value={String(laboralConfig?.endHour ?? 20)}
                    >
                      {HOURS.map((h) => (
                        <s-option key={h.value} value={h.value}>{h.label}</s-option>
                      ))}
                    </s-select>

                    <s-select
                      label="Duración del slot"
                      name="slotDuration"
                      value={String(laboralConfig?.slotDuration ?? 60)}
                    >
                      {SLOT_DURATIONS.map((s) => (
                        <s-option key={s.value} value={s.value}>{s.label}</s-option>
                      ))}
                    </s-select>
                  </s-stack>
                </s-stack>
              </s-section>
            </s-grid-item>

            <s-grid-item>
              <s-section heading="Información">
                <s-paragraph>
                  Define los días y el rango horario en que tu equipo presta servicios en días laborales normales.
                </s-paragraph>
              </s-section>
            </s-grid-item>
          </s-grid>

          <s-box padding="base">
            <s-button type="submit" variant="primary" loading={isSubmitting}>
              Guardar horario laboral
            </s-button>
          </s-box>
        </fetcher.Form>
      )}

      {activeTab === "laboral" && (
        <s-grid gridTemplateColumns="2fr 1fr" gap="base">
          <s-grid-item>
            <s-stack direction="block" gap="base">
              <s-section heading="Días bloqueados">
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    Bloquea días puntuales para que los clientes no puedan agendar en ellos. El motivo es solo visible para el administrador.
                  </s-paragraph>

                  <fetcher.Form method="post" style={{ display: "contents" }}>
                    <input type="hidden" name="intent" value="add-blocked-day" />
                    <s-stack direction="inline" gap="base">
                      <s-date-field
                        label="Fecha"
                        name="date"
                        value={newBlockedDate}
                        onInput={(e: Event) =>
                          setNewBlockedDate((e.target as HTMLInputElement).value)
                        }
                      />
                      <s-text-field
                        label="Motivo (interno)"
                        name="reason"
                        placeholder="Ej: Vacaciones, mantenimiento..."
                        value={newBlockedReason}
                        onInput={(e: Event) =>
                          setNewBlockedReason((e.target as HTMLInputElement).value)
                        }
                      />
                      <s-box padding="base">
                        <s-button type="submit" variant="secondary" loading={isSubmitting}>
                          Bloquear día
                        </s-button>
                      </s-box>
                    </s-stack>
                  </fetcher.Form>

                  {blockedDays.length === 0 ? (
                    <s-paragraph>No hay días bloqueados actualmente.</s-paragraph>
                  ) : (
                    <s-table>
                      <s-table-header>
                        <s-table-header-row>
                          <s-table-cell>Fecha</s-table-cell>
                          <s-table-cell>Motivo</s-table-cell>
                          <s-table-cell></s-table-cell>
                        </s-table-header-row>
                      </s-table-header>
                      <s-table-body>
                        {blockedDays.map((bd) => (
                          <s-table-row key={bd.id}>
                            <s-table-cell>{formatHolidayDate(bd.date)}</s-table-cell>
                            <s-table-cell>
                              {bd.reason ? (
                                <s-text>{bd.reason}</s-text>
                              ) : (
                                <s-text color="subdued">Sin motivo</s-text>
                              )}
                            </s-table-cell>
                            <s-table-cell>
                              <fetcher.Form method="post" style={{ display: "inline" }}>
                                <input type="hidden" name="intent" value="delete-blocked-day" />
                                <input type="hidden" name="id" value={bd.id} />
                                <s-button
                                  type="submit"
                                  variant="tertiary"
                                  tone="critical"
                                  loading={isSubmitting}
                                >
                                  Eliminar
                                </s-button>
                              </fetcher.Form>
                            </s-table-cell>
                          </s-table-row>
                        ))}
                      </s-table-body>
                    </s-table>
                  )}
                </s-stack>
              </s-section>
            </s-stack>
          </s-grid-item>

          <s-grid-item>
            <s-section heading="¿Qué es un día bloqueado?">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Un día bloqueado cierra completamente la agenda: ningún cliente podrá agendar ese día desde su portal.
                </s-paragraph>
                <s-banner tone="warning" heading="Agendamientos existentes">
                  <s-paragraph>
                    Bloquear un día no cancela automáticamente los servicios ya confirmados en esa fecha. Revisa el calendario antes de bloquearlo.
                  </s-paragraph>
                </s-banner>
              </s-stack>
            </s-section>
          </s-grid-item>
        </s-grid>
      )}

      {activeTab === "festivo" && (
        <s-grid gridTemplateColumns="2fr 1fr" gap="base">
          <s-grid-item>
            <s-stack direction="block" gap="base">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="save-festivo" />
                <s-section heading="Horario en días festivos">
                  <s-stack direction="block" gap="base">
                    <s-paragraph>
                      Configura el rango horario para los días marcados como festivos. Si no deseas atender en festivos, simplemente no agregues días festivos al calendario.
                    </s-paragraph>

                    <s-stack direction="inline" gap="base">
                      <s-select
                        label="Hora de inicio"
                        name="startHour"
                        value={String(festivoConfig?.startHour ?? 9)}
                      >
                        {HOURS.map((h) => (
                          <s-option key={h.value} value={h.value}>{h.label}</s-option>
                        ))}
                      </s-select>

                      <s-select
                        label="Hora de fin"
                        name="endHour"
                        value={String(festivoConfig?.endHour ?? 14)}
                      >
                        {HOURS.map((h) => (
                          <s-option key={h.value} value={h.value}>{h.label}</s-option>
                        ))}
                      </s-select>

                    </s-stack>
                  </s-stack>
                </s-section>
                <s-box padding="base">
                  <s-button type="submit" variant="primary" loading={isSubmitting}>
                    Guardar horario festivo
                  </s-button>
                </s-box>
              </fetcher.Form>

              <s-section heading="Días festivos">
                <s-stack direction="block" gap="base">
                  <fetcher.Form method="post" style={{ display: "contents" }}>
                    <input type="hidden" name="intent" value="add-holiday" />
                    <s-stack direction="inline" gap="base">
                      <s-date-field
                        label="Fecha"
                        name="date"
                        value={newHolidayDate}
                        onInput={(e: Event) =>
                          setNewHolidayDate((e.target as HTMLInputElement).value)
                        }
                      />
                      <s-text-field
                        label="Descripción"
                        name="description"
                        placeholder="Ej: Navidad, Día Nacional..."
                        value={newHolidayDesc}
                        onInput={(e: Event) =>
                          setNewHolidayDesc((e.target as HTMLInputElement).value)
                        }
                      />
                      <s-number-field
                        label="Precio extra (€/hora)"
                        name="priceExtra"
                        min={0}
                        step={0.01}
                        value={newHolidayPrice}
                        onInput={(e: Event) =>
                          setNewHolidayPrice((e.target as HTMLInputElement).value)
                        }
                      />
                      <s-box padding="base">
                        <s-button type="submit" variant="secondary" loading={isSubmitting}>
                          Agregar
                        </s-button>
                      </s-box>
                    </s-stack>
                  </fetcher.Form>

                  {holidays.length === 0 ? (
                    <s-paragraph>No hay días festivos configurados.</s-paragraph>
                  ) : (
                    <s-table>
                      <s-table-header>
                        <s-table-header-row>
                          <s-table-cell>Fecha</s-table-cell>
                          <s-table-cell>Descripción</s-table-cell>
                          <s-table-cell>Precio extra/hora</s-table-cell>
                          <s-table-cell></s-table-cell>
                        </s-table-header-row>
                      </s-table-header>
                      <s-table-body>
                        {holidays.map((holiday) => (
                          <s-table-row key={holiday.id}>
                            <s-table-cell>
                              {formatHolidayDate(holiday.date)}
                            </s-table-cell>
                            <s-table-cell>{holiday.description}</s-table-cell>
                            <s-table-cell>
                              {holiday.priceExtra > 0 ? (
                                <s-badge tone="caution">+€{holiday.priceExtra.toFixed(2)}/h</s-badge>
                              ) : (
                                <s-text color="subdued">Sin extra</s-text>
                              )}
                            </s-table-cell>
                            <s-table-cell>
                              <fetcher.Form method="post" style={{ display: "inline" }}>
                                <input type="hidden" name="intent" value="delete-holiday" />
                                <input type="hidden" name="id" value={holiday.id} />
                                <s-button
                                  type="submit"
                                  variant="tertiary"
                                  tone="critical"
                                  loading={isSubmitting}
                                >
                                  Eliminar
                                </s-button>
                              </fetcher.Form>
                            </s-table-cell>
                          </s-table-row>
                        ))}
                      </s-table-body>
                    </s-table>
                  )}
                </s-stack>
              </s-section>
            </s-stack>
          </s-grid-item>

          <s-grid-item>
            <s-section heading="Precio extra en festivos">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Configura el rango horario en que atiendes en días festivos. La duración de cada slot se hereda automáticamente de tu configuración de horario laboral.
                </s-paragraph>
                <s-paragraph>
                  El precio extra por día festivo se aplica sobre el total del servicio (horas × precio extra). Los clientes verán este sobrecargo señalado en el calendario antes de confirmar.
                </s-paragraph>
              </s-stack>
            </s-section>
          </s-grid-item>
        </s-grid>
      )}

      {activeTab === "notifications" && (
        <s-grid gridTemplateColumns="2fr 1fr" gap="base">
          <s-grid-item>
            <s-section heading="Notificaciones automáticas via Shopify Flow">
              <s-stack direction="block" gap="base">
                <s-banner tone="info" heading="Requiere Shopify Flow">
                  <s-paragraph>
                    Las notificaciones de recordatorio se gestionan mediante Shopify Flow. Esta app registra el trigger <strong>Booking Confirmado</strong> que puedes usar en tus automatizaciones.
                  </s-paragraph>
                </s-banner>

                <s-stack direction="block" gap="base">
                  <s-text>Cómo configurar los recordatorios:</s-text>
                  <s-ordered-list>
                    <s-list-item>
                      Accede a{" "}
                      <s-link href="https://admin.shopify.com/flow" target="_blank">
                        Shopify Flow
                      </s-link>{" "}
                      en tu panel de administración.
                    </s-list-item>
                    <s-list-item>
                      Crea un nuevo flujo y selecciona el trigger <strong>"Booking Confirmado"</strong> de esta app.
                    </s-list-item>
                    <s-list-item>
                      Agrega una condición de tiempo: <strong>"Esperar hasta 1 día antes de service_date"</strong>.
                    </s-list-item>
                    <s-list-item>
                      Agrega la acción <strong>"Enviar email al cliente"</strong> con el mensaje de recordatorio 24h antes.
                    </s-list-item>
                    <s-list-item>
                      Crea un segundo flujo similar para el recordatorio de <strong>1 hora antes</strong>.
                    </s-list-item>
                  </s-ordered-list>
                </s-stack>

                <s-divider />

                <s-stack direction="block" gap="base">
                  <s-text>Datos disponibles en el trigger:</s-text>
                  <s-table>
                    <s-table-header>
                      <s-table-header-row>
                        <s-table-cell>Campo</s-table-cell>
                        <s-table-cell>Descripción</s-table-cell>
                      </s-table-header-row>
                    </s-table-header>
                    <s-table-body>
                      <s-table-row>
                        <s-table-cell><strong>customer_email</strong></s-table-cell>
                        <s-table-cell>Email del cliente</s-table-cell>
                      </s-table-row>
                      <s-table-row>
                        <s-table-cell><strong>customer_name</strong></s-table-cell>
                        <s-table-cell>Nombre del cliente</s-table-cell>
                      </s-table-row>
                      <s-table-row>
                        <s-table-cell><strong>service_date</strong></s-table-cell>
                        <s-table-cell>Fecha del servicio (YYYY-MM-DD)</s-table-cell>
                      </s-table-row>
                      <s-table-row>
                        <s-table-cell><strong>start_time</strong></s-table-cell>
                        <s-table-cell>Hora de inicio (HH:MM)</s-table-cell>
                      </s-table-row>
                      <s-table-row>
                        <s-table-cell><strong>hours</strong></s-table-cell>
                        <s-table-cell>Horas contratadas</s-table-cell>
                      </s-table-row>
                      <s-table-row>
                        <s-table-cell><strong>order_name</strong></s-table-cell>
                        <s-table-cell>Número de orden (ej: #1234)</s-table-cell>
                      </s-table-row>
                    </s-table-body>
                  </s-table>
                </s-stack>
              </s-stack>
            </s-section>
          </s-grid-item>

          <s-grid-item>
            <s-section heading="Acceso rápido a Flow">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Shopify Flow está disponible en todos los planes de Shopify Basic y superiores.
                </s-paragraph>
                <s-button
                  href="https://admin.shopify.com/apps/flow"
                  target="_blank"
                  variant="primary"
                >
                  Abrir Shopify Flow
                </s-button>
              </s-stack>
            </s-section>
          </s-grid-item>
        </s-grid>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
