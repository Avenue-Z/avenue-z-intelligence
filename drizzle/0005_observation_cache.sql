CREATE TABLE `observation_cache_entries` (
 `organizationId` text NOT NULL,
 `clientId` text NOT NULL,
 `cacheKey` text NOT NULL,
 `generation` text NOT NULL,
 `status` text NOT NULL,
 `chunkCount` integer NOT NULL,
 `characters` integer NOT NULL,
 `payloadHash` text NOT NULL,
 `createdAt` text NOT NULL,
 PRIMARY KEY (`organizationId`,`clientId`,`cacheKey`)
);
--> statement-breakpoint
CREATE TABLE `observation_cache_chunks` (
 `organizationId` text NOT NULL,
 `clientId` text NOT NULL,
 `cacheKey` text NOT NULL,
 `generation` text NOT NULL,
 `chunkIndex` integer NOT NULL,
 `payload` text NOT NULL,
 PRIMARY KEY (`organizationId`,`clientId`,`cacheKey`,`generation`,`chunkIndex`)
);
