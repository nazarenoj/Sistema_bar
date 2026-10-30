-- C8: producción (Stock RF10, RF11, RF23, RF24, RN15, RN37, RN72). Función STK-PRODUCCION: elaborados de producción previa
-- (se fabrican y quedan en stock), órdenes por tanda con rendimiento y merma, ficha técnica y margen teórico.
-- Re-ejecutable: ALTER condicionado a su columna centinela, tablas IF NOT EXISTS, semillas con INSERT IGNORE.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE productos
       ADD COLUMN modo_produccion ENUM('venta', 'previa') NOT NULL DEFAULT 'venta',
       ADD COLUMN costo_adicional DECIMAL(14,4) NOT NULL DEFAULT 0,
       ADD COLUMN procedimiento   TEXT NULL,
       ADD COLUMN peso_porcion    DECIMAL(10,3) NULL,
       ADD COLUMN conservacion    VARCHAR(255) NULL",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'modo_produccion'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Una orden es una tanda: planificada, con consumos que el usuario puede ajustar, y confirmada con lo realmente producido.
CREATE TABLE IF NOT EXISTS ordenes_produccion (
  id                     INT           AUTO_INCREMENT PRIMARY KEY,
  id_global              VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo                   ENUM('produccion', 'armado') NOT NULL DEFAULT 'produccion',
  producto_id            INT           NOT NULL,
  estado                 ENUM('borrador', 'confirmada', 'cancelada') NOT NULL DEFAULT 'borrador',
  cantidad_planificada   DECIMAL(14,3) NOT NULL,
  cantidad_real          DECIMAL(14,3) NULL,
  deposito_insumos_id    INT           NOT NULL,
  deposito_destino_id    INT           NOT NULL,
  turno                  ENUM('manana', 'tarde') NULL,
  tolerancia_pct         DECIMAL(5,2)  NOT NULL DEFAULT 5,
  peso_crudo             DECIMAL(12,3) NULL,
  peso_final             DECIMAL(12,3) NULL,
  costo_total            DECIMAL(14,4) NULL,
  costo_unitario         DECIMAL(14,4) NULL,
  costo_parcial          TINYINT(1)    NOT NULL DEFAULT 0,
  merma_valorizada       DECIMAL(14,4) NOT NULL DEFAULT 0,
  rendimiento_pct        DECIMAL(7,2)  NULL,
  merma_coccion_pct      DECIMAL(7,2)  NULL,
  lote_codigo            VARCHAR(60)   NULL,
  creada_por             INT           NULL,
  confirmada_por         INT           NULL,
  created_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmada_at          DATETIME      NULL,
  CONSTRAINT uq_orden_id_global UNIQUE (id_global),
  CONSTRAINT fk_orden_producto  FOREIGN KEY (producto_id) REFERENCES productos(id),
  CONSTRAINT fk_orden_dep_ins   FOREIGN KEY (deposito_insumos_id) REFERENCES depositos(id),
  CONSTRAINT fk_orden_dep_dest  FOREIGN KEY (deposito_destino_id) REFERENCES depositos(id),
  KEY idx_orden_estado (estado, created_at)
);

CREATE TABLE IF NOT EXISTS orden_consumos (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  orden_id          INT           NOT NULL,
  item_tipo         ENUM('insumo', 'producto') NOT NULL,
  item_id           INT           NOT NULL,
  cantidad_teorica  DECIMAL(14,3) NOT NULL,
  cantidad_real     DECIMAL(14,3) NOT NULL,
  CONSTRAINT uq_orden_consumo UNIQUE (orden_id, item_tipo, item_id),
  CONSTRAINT fk_consumo_orden FOREIGN KEY (orden_id) REFERENCES ordenes_produccion(id)
);

-- Motivos reservados de la producción: no se usan a mano ni se desactivan (RF12).
INSERT IGNORE INTO motivos_stock (codigo, nombre, tipo, requiere_autorizacion, requiere_observacion, clase_contable, reservado) VALUES
  ('consumo_produccion', 'Consumo de producción',  'egreso',  0, 0, 'otra', 1),
  ('produccion',         'Producción terminada',   'ingreso', 0, 0, 'otra', 1),
  ('merma_produccion',   'Merma de producción',    'egreso',  0, 0, 'merma', 1);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('produccion_tolerancia_pct', '5');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.produccion.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'stock.produccion.gestionar', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.produccion.gestionar', 'permitido'
) p ON p.rol = r.codigo;
