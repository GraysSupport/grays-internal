-- 0010_dispatch_evidence_down.sql — rollback of G18 dispatch evidence. Reversible, but the portal
-- forgets which SharePoint folders/files belong to which workorder. The files themselves stay in
-- SharePoint untouched.

DROP INDEX IF EXISTS idx_dispatch_evidence_files_wo;
DROP TABLE IF EXISTS dispatch_evidence_files;
DROP INDEX IF EXISTS uq_dispatch_evidence_folders;
DROP TABLE IF EXISTS dispatch_evidence_folders;
