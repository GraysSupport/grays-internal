-- 0006_user_roles_granted_by_fk_down.sql — reverse 0006.
--
-- Restores the original FK (no ON DELETE clause = NO ACTION). Note that reverting
-- re-introduces the failure this migration fixes: deleting a user who has granted a role
-- will raise 23503 again. Only roll back alongside the F9 code that populates granted_by.

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_granted_by_fkey;

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_granted_by_fkey
  FOREIGN KEY (granted_by) REFERENCES users(id);
