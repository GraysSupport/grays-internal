-- 0009_lot_checklists_down.sql — rollback of G16 technician checklists. Reversible, but the
-- recorded checklists are lost. Serials already written back to workorder_items.item_sn and
-- product_lots.serial_number stay (they are ordinary data on those tables).

DROP INDEX IF EXISTS idx_lot_checklists_woitem;
DROP TABLE IF EXISTS lot_checklists;
