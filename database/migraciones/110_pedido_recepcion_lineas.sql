-- Compras RF12/RN08: cuánto aportó cada ingreso vinculado a cada línea de pedido, para poder revertirlo si se desvincula. Re-ejecutable.
CREATE TABLE IF NOT EXISTS cmp_pedido_recepcion_lineas (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id         INT           NOT NULL,
  ingreso_id_global VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  linea_id          INT           NOT NULL,
  cantidad          DECIMAL(14,4) NOT NULL,
  KEY idx_cmp_recep_ingreso (ingreso_id_global),
  KEY idx_cmp_recep_pedido (pedido_id, ingreso_id_global)
);
