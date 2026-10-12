CREATE TABLE `prepared_workspace_cache` (
 `organizationId` text NOT NULL,
 `clientId` text NOT NULL,
 `cacheKey` text NOT NULL,
 `codecVersion` text NOT NULL,
 `payload` text NOT NULL CHECK (length(`payload`) <= 524288),
 `payloadHash` text NOT NULL,
 `createdAt` integer NOT NULL,
 `expiresAt` integer NOT NULL,
 PRIMARY KEY (`organizationId`,`clientId`,`cacheKey`)
);
--> statement-breakpoint
CREATE INDEX `idx_prepared_workspace_cache_retention` ON `prepared_workspace_cache` (`organizationId`,`clientId`,`createdAt`);
