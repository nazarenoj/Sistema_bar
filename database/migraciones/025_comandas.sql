-- B3: comandas por sector (Ventas RF07, RN11, EX08). Cada envío de ítems a producción genera una comanda por
-- sector de destino (el del artículo, B1). Un ítem enviado queda marcado (`enviado_at`): quitarlo después exige
-- motivo y permiso (RN11). La comanda sin imprimir (`impresa_at` nulo) es la cola de la terminal de destino (EX08).
-- Re-ejecutable: el ALTER se arma solo si su columna centinela no existe.

CREATE TABLE IF NOT EXISTS comandas (
  id                INT          AUTO_INCREMENT PRIMARY KEY,
  id_global         VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  envio             VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mesa_id           INT          NOT NULL,
  sesion_apertura   DATETIME     NOT NULL,
  sector_id         INT          NULL,
  modalidad         VARCHAR(20)  NOT NULL DEFAULT 'salon',
  referencia        VARCHAR(255) NULL,
  mozo_id           INT          NULL,
  estado            ENUM('emitida', 'anulada') NOT NULL DEFAULT 'emitida',
  motivo_anulacion  VARCHAR(255) NULL,
  anulada_por       INT          NULL,
  anulada_at        DATETIME     NULL,
  creado_por        INT          NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  impresa_at        DATETIME     NULL,
  reimpresiones     INT          NOT NULL DEFAULT 0,
  CONSTRAINT uq_comanda_id_global UNIQUE (id_global),
  CONSTRAINT fk_comanda_mesa      FOREIGN KEY (mesa_id)   REFERENCES mesas(id),
  CONSTRAINT fk_comanda_sector    FOREIGN KEY (sector_id) REFERENCES sectores_comanda(id),
  KEY idx_comanda_cola (impresa_at, estado, sector_id),
  KEY idx_comanda_envio (envio)
);

-- Una línea por ítem a preparar; un combo aparece como una línea por componente, cada uno en su sector (RN69).
CREATE TABLE IF NOT EXISTS comanda_items (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  comanda_id         INT          NOT NULL,
  pedido_producto_id INT          NOT NULL,
  pedido_id          INT          NOT NULL,
  producto_id        INT          NOT NULL,
  nombre             VARCHAR(255) NOT NULL,
  cantidad           DECIMAL(10,3) NOT NULL,
  observaciones      VARCHAR(255) NULL,
  CONSTRAINT fk_comitem_comanda FOREIGN KEY (comanda_id) REFERENCES comandas(id)
);

SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE pedido_productos ADD COLUMN enviado_at DATETIME NULL", 'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'pedido_productos' AND column_name = 'enviado_at'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
