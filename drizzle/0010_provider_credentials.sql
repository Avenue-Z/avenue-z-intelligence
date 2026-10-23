CREATE TABLE `provider_credentials` (
 `organizationId` text NOT NULL,
 `clientId` text NOT NULL,
 `provider` text NOT NULL,
 `payload` text NOT NULL CHECK (length(`payload`) <= 87425),
 `updatedAt` text NOT NULL,
 PRIMARY KEY (`organizationId`,`clientId`,`provider`)
);
