-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HourPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineItemId" TEXT NOT NULL DEFAULT '',
    "orderName" TEXT NOT NULL DEFAULT '',
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "variantId" TEXT NOT NULL DEFAULT '',
    "scheduleKind" TEXT NOT NULL DEFAULT 'LABORAL',
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT '',
    "customerId" TEXT NOT NULL DEFAULT '',
    "customerAddress" TEXT NOT NULL DEFAULT '',
    "customerTags" TEXT NOT NULL DEFAULT '',
    "hoursTotal" INTEGER NOT NULL,
    "hoursUsed" INTEGER NOT NULL DEFAULT 0,
    "purchasedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "accessToken" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_HourPackage" ("accessToken", "createdAt", "customerAddress", "customerEmail", "customerId", "customerName", "customerTags", "expiresAt", "hoursTotal", "hoursUsed", "id", "orderId", "orderName", "productId", "productTitle", "purchasedAt", "shop", "updatedAt") SELECT "accessToken", "createdAt", "customerAddress", "customerEmail", "customerId", "customerName", "customerTags", "expiresAt", "hoursTotal", "hoursUsed", "id", "orderId", "orderName", "productId", "productTitle", "purchasedAt", "shop", "updatedAt" FROM "HourPackage";
DROP TABLE "HourPackage";
ALTER TABLE "new_HourPackage" RENAME TO "HourPackage";
CREATE UNIQUE INDEX "HourPackage_shop_orderId_orderLineItemId_key" ON "HourPackage"("shop", "orderId", "orderLineItemId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
