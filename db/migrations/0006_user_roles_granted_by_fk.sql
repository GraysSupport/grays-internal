-- 0006_user_roles_granted_by_fk.sql — F9
--
-- user_roles.granted_by references users(id) with no ON DELETE clause (i.e. NO ACTION).
-- That was harmless while granted_by was always NULL, but F9 starts populating it with
-- the acting admin's id — at which point deleting a user who has ever granted a role to
-- someone else raises a 23503 foreign-key violation and DELETE /api/users fails.
--
-- The audit intent is "keep the grant, forget the grantor": ON DELETE SET NULL preserves
-- the user_roles row (the grantee keeps their role) and simply clears the attribution.
-- Enforced in the DB so every delete path is covered, not just the one handler.
--
-- Additive + idempotent + reversible: only the FK's delete action changes; no data moves.
-- (user_roles.user_id keeps its existing ON DELETE CASCADE — deleting a user still
-- removes that user's own roles.)

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_granted_by_fkey;

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_granted_by_fkey
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL;
