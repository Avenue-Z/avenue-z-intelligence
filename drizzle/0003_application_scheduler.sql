CREATE TABLE `runner_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`leaseUntil` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`clientId` text NOT NULL,
	`storeDate` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`dueAt` text NOT NULL,
	`leaseToken` text,
	`leaseUntil` text,
	`error` text,
	`reviewId` text,
	`completedAt` text
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_reviews_due` ON `scheduled_reviews` (`organizationId`,`status`,`dueAt`);