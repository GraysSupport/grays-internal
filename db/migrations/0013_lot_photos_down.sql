-- 0013_lot_photos_down.sql — rollback of G27 before-refurbishment photos. Reversible, but the
-- portal forgets which SharePoint folders/files belong to which lot. The files themselves stay
-- in SharePoint untouched.

DROP TABLE IF EXISTS item_photo_folders;
DROP INDEX IF EXISTS idx_lot_photos_item;
DROP INDEX IF EXISTS idx_lot_photos_lot;
DROP TABLE IF EXISTS lot_photos;
DROP TABLE IF EXISTS lot_photo_folders;
