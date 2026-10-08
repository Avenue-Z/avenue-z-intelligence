CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`actorId` text NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`timezone` text NOT NULL,
	`currency` text NOT NULL,
	`color` text NOT NULL,
	`config` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`endpoint` text NOT NULL,
	`secretRef` text NOT NULL,
	`pollMinutes` integer NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`lastSuccess` text,
	`coverageThrough` text,
	`error` text,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `current_snapshots` (
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`sourceId` text NOT NULL,
	`date` text NOT NULL,
	`snapshotId` text NOT NULL,
	PRIMARY KEY(`organizationId`, `clientId`, `sourceId`, `date`)
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`payload` text NOT NULL,
	`version` integer NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`sourceId` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`leaseUntil` text,
	`dueAt` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_status_due` ON `jobs` (`status`,`dueAt`);--> statement-breakpoint
CREATE TABLE `members` (
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`actorId` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`clients` text NOT NULL,
	PRIMARY KEY(`organizationId`, `email`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`body` text NOT NULL,
	`actorId` text NOT NULL,
	`version` integer NOT NULL,
	`updatedAt` text NOT NULL,
	PRIMARY KEY(`organizationId`, `clientId`)
);
--> statement-breakpoint
CREATE TABLE `observations` (
	`snapshotId` text NOT NULL,
	`date` text NOT NULL,
	`rowKey` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`snapshotId`, `date`, `rowKey`)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`initialized` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`storeDate` text NOT NULL,
	`revision` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` text NOT NULL,
	`current` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reviews_client_date` ON `reviews` (`organizationId`,`clientId`,`storeDate`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`sourceId` text NOT NULL,
	`retrievedAt` text NOT NULL,
	`coverageThrough` text,
	`complete` integer NOT NULL,
	`status` text NOT NULL,
	`objectKey` text NOT NULL
);
