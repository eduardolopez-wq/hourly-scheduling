### README de Despliegue – App Shopify `HourlyScheduling`

Este documento describe los requisitos y pasos necesarios para desplegar la aplicación **HourlyScheduling** (app embebida de Shopify con backend Node/Remix y Prisma).

---

### 1. Requisitos del servidor

#### 1.1. Sistema operativo

- Linux (recomendado: Ubuntu 22.04 LTS o superior).
- Acceso por SSH o pipeline CI/CD con capacidad de ejecutar comandos de Node.

#### 1.2. Runtime

- Node.js: **20.x LTS** (mínimo 18.x LTS).
- npm (incluido con Node).
- Opcional pero recomendado: PM2 o `systemd` para ejecutar el proceso en segundo plano.

#### 1.3. Red y dominio

- Dominio o subdominio público con **HTTPS** obligatorio, por ejemplo:
  - `https://apps.vivofacil.com`
  - o la URL que defina Infraestructura.
- Reverse proxy (Nginx/Apache/LB) con:
  - Certificado TLS válido (Let’s Encrypt u otro).
  - Proxy de la URL pública hacia el puerto interno donde corre la app (por ejemplo `http://127.0.0.1:3000`).
- Sin autenticación adicional (no Basic Auth ni IP whitelists que bloqueen a Shopify).

#### 1.4. Almacenamiento y base de datos

El proyecto usa **Prisma**. Por defecto está configurado con **SQLite**:

- Opción A – SQLite (simple, un solo servidor)
  - Directorio de la app con permiso de lectura/escritura.
  - Volumen o disco persistente (no efímero) para el archivo de base de datos (por defecto `dev.sqlite` en la carpeta `prisma`).
  - Adecuado si solo habrá una instancia del servidor.

- Opción B – Base de datos externa (recomendado para producción)
  - Instancia gestionada de **PostgreSQL** o **MySQL**.
  - Proveer:
    - Host, puerto, usuario, contraseña y nombre de base de datos.
    - Cadena de conexión `DATABASE_URL`.
  - La app correrá migraciones con Prisma contra esta base de datos.

---

### 2. Variables de entorno

El servidor debe permitir configurar las siguientes variables de entorno (idealmente como secretos):

- **`SHOPIFY_APP_URL`**  
  URL pública de la app, incluyendo protocolo.  
  Ejemplo: `https://apps.vivofacil.com`.

- **`SHOPIFY_API_KEY`**  
  API key de la app Shopify (desde el Dev Dashboard).

- **`SHOPIFY_API_SECRET`**  
  API secret de la app Shopify (desde el Dev Dashboard). Debe tratarse como secreto.

- **`SCOPES`**  
  Lista de scopes autorizados, en formato de texto separado por comas (debe coincidir con lo configurado en Shopify).  
  Ejemplo aproximado (debe alinearse con `shopify.app.toml`):  
  `write_metaobject_definitions,write_metaobjects,write_products,read_orders,read_customers`

- **`PORT`**  
  Puerto interno en el que correrá la app Node (por ejemplo `3000`).

- **`DATABASE_URL`** (solo si se usa Postgres/MySQL)  
  Cadena de conexión para Prisma.  
  Ejemplo Postgres:  
  `postgresql://usuario:password@host:5432/nombre_bd?schema=public`

Si se mantiene SQLite local, `DATABASE_URL` no es estrictamente necesaria (Prisma usa el archivo local configurado en `schema.prisma`).

---

### 3. Preparación del código en el servidor

Se asume que el código se desplegará en una ruta como:

```bash
/var/www/hourly-scheduling
```

#### 3.1. Instalar dependencias

Dentro del directorio del proyecto:

```bash
cd /ruta/al/proyecto/hourly-scheduling
npm ci          # o npm install, según política de despliegue
```

Se recomienda `npm ci` en entornos de producción porque respeta el lockfile.

#### 3.2. Build de la aplicación

```bash
npm run build
```

Esto genera los artefactos de producción (bundles, etc.) que usará la app en modo `start`.

#### 3.3. Migraciones de base de datos

Si se usa Postgres/MySQL:

```bash
npx prisma migrate deploy
```

Si se usa SQLite y el archivo aún no existe, puede ser necesario inicialmente:

```bash
npx prisma migrate deploy
```

---

### 4. Ejecución en producción

#### 4.1. Arranque simple (para pruebas)

```bash
PORT=3000 npm run start
```

El reverse proxy debe apuntar `https://apps.vivofacil.com` (o la URL definida) a `http://127.0.0.1:3000`.

#### 4.2. Arranque recomendado con PM2

Ejemplo con **pm2**:

```bash
pm2 start npm --name "hourly-scheduling" -- run start
pm2 save
```

También puede definirse un servicio **systemd** que ejecute `npm run start` con las variables de entorno cargadas.

---

### 5. Configuración en Shopify (referencia)

Estos pasos los realiza el equipo de desarrollo, pero se incluyen para contexto:

1. En `shopify.app.toml` se debe configurar:
   - `application_url = "https://apps.vivofacil.com"` (o la URL real de despliegue).
   - `[auth].redirect_urls` apuntando a esa URL (por ejemplo `https://apps.vivofacil.com/api/auth`).
   - `[app_proxy].url` apuntando a la ruta proxy (por ejemplo `https://apps.vivofacil.com/apps/scheduling`).
2. Con la app Shopify seleccionada, ejecutar:

   ```bash
   shopify app deploy
   ```

   Esto actualiza la configuración en Shopify (URLs, proxy, webhooks, etc.) para usar la nueva `SHOPIFY_APP_URL`.

3. Una vez desplegada y con la URL estable, se puede:
   - Instalar la app en la tienda de test.
   - Configurar la distribución (Custom/Public) y enviarla a revisión para la Shopify App Store.

---

### 6. Resumen rápido para Infraestructura

- **Runtime**: Linux + Node 20.x + npm.
- **App**: proceso Node/Remix expuesto en un puerto interno (por ejemplo 3000).
- **Proxy**: dominio HTTPS público → proxy a `localhost:PORT`.
- **Datos**:
  - O bien disco persistente para SQLite,
  - O bien base de datos Postgres/MySQL con `DATABASE_URL`.
- **Config**: soporte para variables de entorno (`SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `PORT`, `DATABASE_URL` si aplica).
- **Flujo de deploy**:
  - `npm ci`
  - `npm run build`
  - `npx prisma migrate deploy`
  - `npm run start` (bajo PM2 o systemd).

