-- 0007_delivery_board_notes_down.sql — rollback of G7 delivery board notes. Reversible
-- (the note text itself is lost — it is free-text scratch, not a record of anything).

DROP TABLE IF EXISTS delivery_board_notes;
