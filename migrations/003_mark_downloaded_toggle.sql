-- Lets a local-scan/WPL import choose whether matching an existing (or new)
-- canonical track should auto-mark it downloaded. Default preserves prior
-- behavior (always mark downloaded) for anyone upgrading from before this
-- option existed; new scans choose explicitly via the UI/API.
--
-- Stored per normalized_entries row (not just per-import) so the dedupe
-- engine can decide per-entry without a join, consistent with how
-- file_path/media_kind/identify_method are already carried per row.

ALTER TABLE normalized_entries ADD COLUMN mark_downloaded_on_match INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scan_jobs ADD COLUMN mark_downloaded INTEGER NOT NULL DEFAULT 1;
