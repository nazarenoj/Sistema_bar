-- I7: envíos propios y retiro (Ventas Online RF11, RF26, RN37). Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_tienda ADD COLUMN capacidad_franja INT NOT NULL DEFAULT 5, ADD COLUMN anticipacion_max_dias INT NOT NULL DEFAULT 7, ADD COLUMN demora_carga_min INT NOT NULL DEFAULT 10",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'capacidad_franja'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE onl_publicados ADD COLUMN prep_min INT NOT NULL DEFAULT 0", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_publicados' AND column_name = 'prep_min'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_pedidos ADD COLUMN programado_ms BIGINT NULL, ADD COLUMN listo_ms BIGINT NULL, ADD COLUMN tiempo_estimado_min INT NOT NULL DEFAULT 0, ADD COLUMN numero_retiro VARCHAR(10) NULL, ADD COLUMN zona_id INT NULL, ADD KEY idx_onl_pedido_programado (programado_ms)",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_pedidos' AND column_name = 'programado_ms'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Zonas de delivery propio por código postal, con tarifa, plazo y mínimo de compra (RF11).
CREATE TABLE IF NOT EXISTS onl_zonas (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  nombre           VARCHAR(80)   NOT NULL,
  codigos_postales TEXT          NOT NULL,
  costo            DECIMAL(12,2) NOT NULL DEFAULT 0,
  plazo_min        INT           NOT NULL DEFAULT 60,
  minimo_compra    DECIMAL(12,2) NOT NULL DEFAULT 0,
  gratis_desde     DECIMAL(12,2) NULL,
  activa           TINYINT(1)    NOT NULL DEFAULT 1,
  CONSTRAINT uq_onl_zona_nombre UNIQUE (nombre)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.envios.configurar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'ventas_online.envios.despachar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas_online.envios.despachar', 'permitido'
) p ON p.rol = r.codigo;
