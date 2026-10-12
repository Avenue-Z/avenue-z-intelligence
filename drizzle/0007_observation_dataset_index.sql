-- Seek selected datasets within a captured snapshot/day before decoding payloads.
-- Dataset identity comes from payload, including legacy rows with opaque row keys.
CREATE INDEX `idx_observations_snapshot_date_dataset_rowkey`
ON `observations` (`snapshotId`, `date`, json_extract(`payload`, '$.dataset'), `rowKey`);
