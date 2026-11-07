-- H3: vínculo de los comprobantes de compra con los ingresos de Stock, lotes y series en la recepción (Compras RF04, RF19, RF24, RN13, RN24, RN25, RN37, RN39, EX06, EX14, EX15, EX19, EX23).
-- Re-ejecutable: la columna se agrega solo si falta.

-- Stock marca el ingreso con el comprobante que lo factura («Pendiente de factura» mientras no lo tiene).
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE stock_ingresos ADD COLUMN compras_comprobante VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL, ADD KEY idx_ingreso_compras (compras_comprobante)',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'stock_ingresos' AND column_name = 'compras_comprobante'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Un vínculo por ingreso: «vinculado» a uno que ya existía o «generado» por Compras en el acto de carga. El estado (Pendiente de confirmar, Confirmado o Rechazado)
-- sale del mensaje que viaja a Stock (RN33); el ingreso generado se conoce cuando Stock lo confirma.
CREATE TABLE IF NOT EXISTS cmp_vinculos_ingreso (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  comprobante_id     INT           NOT NULL,
  origen             ENUM('vinculado', 'generado') NOT NULL,
  ingreso_id_global  VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  estado             ENUM('activo', 'desvinculado') NOT NULL DEFAULT 'activo',
  id_operacion       VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  diferencias        TEXT          NULL,
  motivo             VARCHAR(255)  NULL,
  user_id            INT           NULL,
  ts_ms              BIGINT        NOT NULL,
  CONSTRAINT fk_cmp_vinculo_comp FOREIGN KEY (comprobante_id) REFERENCES cmp_comprobantes(id),
  KEY idx_cmp_vinculo_comp (comprobante_id),
  KEY idx_cmp_vinculo_ingreso (ingreso_id_global)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.ingresos.vincular' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.ingresos.vincular', 'permitido' UNION ALL
  SELECT 'deposito', 'compras.ingresos.vincular', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.lotes.cargar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.lotes.cargar', 'permitido' UNION ALL
  SELECT 'deposito', 'compras.lotes.cargar', 'permitido'
) p ON p.rol = r.codigo;
