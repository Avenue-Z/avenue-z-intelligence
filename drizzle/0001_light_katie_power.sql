CREATE TABLE `qualifications` (
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`sourceId` text NOT NULL,
	`connectionVersion` integer NOT NULL,
	`clientVersion` integer NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	`actorId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`organizationId`, `sourceId`, `version`)
);
--> statement-breakpoint
ALTER TABLE `current_snapshots` ADD `publishedAt` text DEFAULT '' NOT NULL;