-- 0011_free_weights_down.sql — rollback of G21 Brand New Free Weights. Reversible, but every
-- free-weights product line, stock count and stock-move history is lost. Nothing else changes
-- (the free-weights stock never touched `product`, lots or workorders).

DROP INDEX IF EXISTS idx_free_weight_moves_variant;
DROP TABLE IF EXISTS free_weight_stock_moves;
DROP TABLE IF EXISTS free_weight_variants;
DROP INDEX IF EXISTS uq_free_weight_products_brand_name;
DROP TABLE IF EXISTS free_weight_products;
