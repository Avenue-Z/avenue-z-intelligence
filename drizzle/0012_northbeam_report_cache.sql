CREATE TABLE northbeam_report_cache (
 organizationId TEXT NOT NULL,
 clientId TEXT NOT NULL CHECK (clientId='autobrush'),
 profile TEXT NOT NULL CHECK (profile='clicks-only-accrual-7d-daily-v1'),
 date TEXT NOT NULL,
 payload TEXT NOT NULL CHECK (length(payload)<=16000),
 capturedAt TEXT NOT NULL,
 PRIMARY KEY (organizationId,clientId,profile,date)
);
--> statement-breakpoint
CREATE TABLE northbeam_export_state (
 organizationId TEXT NOT NULL,
 clientId TEXT NOT NULL CHECK (clientId='autobrush'),
 profile TEXT NOT NULL CHECK (profile='clicks-only-accrual-7d-daily-v1'),
 date TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('creating','pending','complete','retry','blocked')),
 bucket INTEGER NOT NULL,
 resume TEXT CHECK (resume IS NULL OR length(resume)<=4096),
 lastAttempt TEXT NOT NULL,
 lastError TEXT,
 PRIMARY KEY (organizationId,clientId,profile,date)
);
