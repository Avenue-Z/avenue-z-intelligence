CREATE TABLE `ga4_report_cache` (
 `organizationId` text NOT NULL,
 `clientId` text NOT NULL,
 `propertyId` text NOT NULL,
 `storeDate` text NOT NULL,
 `kind` text NOT NULL CHECK (`kind` IN ('total','hourly','detail')),
 `payload` text NOT NULL CHECK (length(`payload`) <= 5592408),
 `capturedAt` text NOT NULL,
 PRIMARY KEY (`organizationId`,`clientId`,`propertyId`,`storeDate`,`kind`)
);
