# HourlyScheduling

App embebida de Shopify para gestionar una **bolsa de horas de servicio** (laborales y festivas), con portal de cliente para agendamiento y panel admin para operación diaria.

## Funcionalidades principales

- Compra de paquetes de horas desde la tienda Shopify.
- Procesamiento de órdenes pagadas vía webhook `orders/paid`.
- Separación de horas por tipo: `LABORAL` y `FESTIVO`.
- Bolsa de horas unificada por cliente (totales y consumo FIFO).
- Portal cliente (`/portal/:token`) para agendar servicios.
- Bloqueo de días desde configuración (afecta admin y cliente).
- Dashboard admin con métricas por bolsa (no por orden).
- Vista de calendario y vista de detalle de órdenes con filtros y paginación.
- Integración con Shopify Flow para eventos de booking.

## Stack técnico

- **Framework:** React Router (Shopify app template)
- **Backend:** Node.js + TypeScript
- **ORM:** Prisma
- **Base de datos local:** SQLite (`prisma/dev.sqlite`)
- **Shopify:** App Bridge + Admin API + Webhooks + App Proxy

## Estructura funcional (alto nivel)

- `app/routes/app._index.tsx`: dashboard principal.
- `app/routes/app.calendar.tsx`: calendario admin + bolsas.
- `app/routes/app.packages.tsx`: detalle de órdenes.
- `app/routes/app.scheduling-config.tsx`: horarios, festivos y bloqueos.
- `app/routes/portal.$token.tsx`: portal público de agendamiento.
- `app/routes/webhooks.orders.paid.tsx`: creación de paquetes desde órdenes pagadas.
- `app/routes/apps.scheduling.tsx`: endpoints de App Proxy.
- `prisma/schema.prisma`: modelos de dominio (`HourPackage`, `BookingSlot`, `BlockedDay`, etc.).

## Requisitos

- Node.js `>=20.19 <22 || >=22.12`
- npm
- Shopify CLI
- Cuenta Shopify Partner + tienda de desarrollo

## Instalación local

```bash
npm install
npm run setup
npm run dev
```

Comandos útiles:

```bash
npm run typecheck
npm run lint
npm run build
npm run start
```

## Variables de entorno

Configura las variables estándar de Shopify app:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SCOPES`
- `SHOPIFY_APP_URL`
- `SHOP_CUSTOM_DOMAIN` (opcional)

> Nota: `shopify.app.toml` contiene configuración de webhooks, scopes, auth y app proxy.

## Flujo de negocio resumido

1. El cliente compra un paquete de horas en la tienda.
2. Shopify dispara `orders/paid`.
3. Se crea/actualiza `HourPackage` (por `orderLineItemId`) con `scheduleKind`.
4. El cliente accede a su portal por `accessToken`.
5. Agenda un slot compatible con el tipo de día.
6. Se crea `BookingSlot` y se consume saldo por FIFO.

## Despliegue

Para revisión/publicación en Shopify necesitas una URL pública HTTPS (no solo localhost).

Flujo recomendado:

1. Desplegar app (Render, Railway, Fly, VPS, etc.).
2. Configurar `SHOPIFY_APP_URL` de producción.
3. Actualizar `application_url` y `redirect_urls` en `shopify.app.toml`.
4. Ejecutar:

```bash
npm run deploy
```

5. Validar OAuth, webhooks y App Proxy en ambiente productivo.

## Estado del proyecto

Proyecto en evolución activa para operación real de servicios por bolsa de horas en Shopify.
