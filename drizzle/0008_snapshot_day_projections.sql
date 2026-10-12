CREATE TABLE `snapshot_day_projection_entries` (
 `organizationId` text NOT NULL,
 `clientId` text NOT NULL,
 `snapshotId` text NOT NULL,
 `date` text NOT NULL,
 `codecVersion` integer NOT NULL,
 `generation` text NOT NULL,
 `status` text NOT NULL,
 `chunkCount` integer NOT NULL,
 `characters` integer NOT NULL,
 `payloadHash` text NOT NULL,
 `createdAt` text NOT NULL,
 PRIMARY KEY (`organizationId`,`clientId`,`snapshotId`,`date`,`codecVersion`)
);
--> statement-breakpoint
CREATE TABLE `snapshot_day_projection_chunks` (
 `organizationId` text NOT NULL,
 `clientId` text NOT NULL,
 `snapshotId` text NOT NULL,
 `date` text NOT NULL,
 `codecVersion` integer NOT NULL,
 `generation` text NOT NULL,
 `chunkIndex` integer NOT NULL,
 `payload` text NOT NULL,
 PRIMARY KEY (`organizationId`,`clientId`,`snapshotId`,`date`,`codecVersion`,`generation`,`chunkIndex`)
);
