CREATE TABLE `member_identities` (
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`actorId` text NOT NULL,
	PRIMARY KEY(`organizationId`, `actorId`)
);
