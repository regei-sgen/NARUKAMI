-- CreateTable
CREATE TABLE "EodEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "note" TEXT,
    "summary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EodEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EodEntry_projectId_day_idx" ON "EodEntry"("projectId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "EodEntry_projectId_day_key" ON "EodEntry"("projectId", "day");
