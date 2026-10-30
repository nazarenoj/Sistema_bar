-- C5: compromiso de venta, última unidad (Stock RF36, RN59, RN60; Ventas RN63). Los artículos del catálogo también
-- declaran si controlan stock y si admiten stock negativo (RF01): solo los que NO lo admiten se comprometen (con
-- bloqueo). Por defecto un artículo admite negativo —se vende igual, como hasta ahora—; el control estricto se
-- activa por artículo. Re-ejecutable: el ALTER se arma solo si su columna centinela no existe.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE productos
       ADD COLUMN controla_stock   TINYINT(1) NOT NULL DEFAULT 1,
       ADD COLUMN permite_negativo TINYINT(1) NOT NULL DEFAULT 1",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'controla_stock'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
