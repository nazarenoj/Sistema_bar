-- C1: base de Stock (Stock RF01 a RF03, RN61, EX46). Configuración de ítems, depósitos y presentaciones con
-- versión. Una presentación que ya se usó no se edita: se crea una versión nueva y la anterior queda vencida.
-- Re-ejecutable: cada ALTER se arma solo si su columna centinela no existe.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE insumos
       ADD COLUMN controla_stock   TINYINT(1) NOT NULL DEFAULT 1,
       ADD COLUMN control_estricto TINYINT(1) NOT NULL DEFAULT 0,
       ADD COLUMN permite_negativo TINYINT(1) NOT NULL DEFAULT 0",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'insumos' AND column_name = 'controla_stock'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Depósitos de la instancia; siempre uno predeterminado (RF03).
CREATE TABLE IF NOT EXISTS depositos (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(100) NOT NULL,
  activo         TINYINT(1)   NOT NULL DEFAULT 1,
  predeterminado TINYINT(1)   NOT NULL DEFAULT 0,
  CONSTRAINT uq_deposito_nombre UNIQUE (nombre)
);
INSERT IGNORE INTO depositos (nombre, predeterminado) VALUES ('Depósito principal', 1);

-- De qué depósito descuenta cada sector de comanda (sin fila, el predeterminado).
CREATE TABLE IF NOT EXISTS sector_deposito (
  sector_id   INT NOT NULL PRIMARY KEY,
  deposito_id INT NOT NULL,
  CONSTRAINT fk_sd_sector   FOREIGN KEY (sector_id)   REFERENCES sectores_comanda(id) ON DELETE CASCADE,
  CONSTRAINT fk_sd_deposito FOREIGN KEY (deposito_id) REFERENCES depositos(id)
);

-- Stock mínimo y punto de reposición de un ítem en cada depósito.
CREATE TABLE IF NOT EXISTS item_deposito_config (
  insumo_id         INT           NOT NULL,
  deposito_id       INT           NOT NULL,
  stock_minimo      DECIMAL(12,3) NOT NULL DEFAULT 0,
  punto_reposicion  DECIMAL(12,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (insumo_id, deposito_id),
  CONSTRAINT fk_idc_insumo   FOREIGN KEY (insumo_id)   REFERENCES insumos(id) ON DELETE CASCADE,
  CONSTRAINT fk_idc_deposito FOREIGN KEY (deposito_id) REFERENCES depositos(id)
);

-- Presentaciones de un ítem: nombre, factor a la unidad base, usos y versión (RF02). La unidad base del ítem es
-- `insumos.unidad` (factor 1). `vigente_hasta` nulo = vigente.
CREATE TABLE IF NOT EXISTS presentaciones (
  id                      INT           AUTO_INCREMENT PRIMARY KEY,
  id_global               VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  insumo_id               INT           NOT NULL,
  nombre                  VARCHAR(100)  NOT NULL,
  factor                  DECIMAL(18,6) NOT NULL,
  usos                    SET('compra', 'receta', 'venta', 'fraccionamiento') NOT NULL,
  version                 INT           NOT NULL DEFAULT 1,
  version_anterior_id     INT           NULL,
  vigente_desde           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  vigente_hasta           DATETIME      NULL,
  CONSTRAINT uq_presentacion_id_global UNIQUE (id_global),
  CONSTRAINT uq_presentacion_version   UNIQUE (insumo_id, nombre, version),
  CONSTRAINT fk_presentacion_insumo    FOREIGN KEY (insumo_id) REFERENCES insumos(id),
  KEY idx_presentacion_vigente (insumo_id, vigente_hasta)
);

-- La línea de receta puede usar una presentación (la receta en gramos de un ítem que se controla en kg): guarda
-- el ID y el factor aplicado, así un cambio posterior de la presentación no la altera (RF02).
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE producto_insumos
       ADD COLUMN presentacion_id INT NULL,
       ADD COLUMN factor_aplicado DECIMAL(18,6) NULL,
       ADD CONSTRAINT fk_pi_presentacion FOREIGN KEY (presentacion_id) REFERENCES presentaciones(id)",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'producto_insumos' AND column_name = 'presentacion_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO parametros (clave, valor) VALUES ('stock_precision_factor', '6');
