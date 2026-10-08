CREATE TABLE `ai_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`actorId` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_requests_actor` ON `ai_requests` (`organizationId`,`actorId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `ai_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`actorId` text NOT NULL,
	`scopeKey` text NOT NULL,
	`question` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_turns_scope` ON `ai_turns` (`organizationId`,`actorId`,`scopeKey`,`createdAt`);