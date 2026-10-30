-- C14: reposición automática sugerida (Stock RF29, EX40) y app móvil de inventario (RF28). Funciones STK-REPO-AUTO y STK-APP.
-- La sugerencia nunca compra: solo arma la lista. Re-ejecutable: tabla IF NOT EXISTS, semillas con INSERT IGNORE.

-- Datos de reposición por ítem: stock de seguridad, plazo de entrega (sin Compras se define acá, EX40) y cobertura propia.
CREATE TABLE IF NOT EXISTS item_reposicion (
  item_tipo          ENUM('insumo', 'producto') NOT NULL,
  item_id            INT           NOT NULL,
  stock_seguridad    DECIMAL(12,3) NOT NULL DEFAULT 0,
  plazo_entrega_dias INT           NULL,
  dias_cobertura     INT           NULL,
  PRIMARY KEY (item_tipo, item_id)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('repo_ventana_semanas', '8'), ('repo_dias_cobertura', '7');
