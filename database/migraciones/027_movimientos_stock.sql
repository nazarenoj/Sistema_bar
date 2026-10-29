-- C2: movimientos y kardex (Stock RF04, RF12, RF13, RF18, RN02). Todo cambio de existencias es un movimiento de
-- solo agregar; el saldo sale de sumarlos y un error se corrige con un movimiento inverso que referencia al
-- original. `insumos.stock` y `productos.stock` pasan a ser un total derivado: un trigger impide cambiarlos si
-- no es a través del servicio de movimientos.
-- Re-ejecutable: las tablas son IF NOT EXISTS, los triggers se recrean y el saldo inicial solo se carga una vez.

-- Motivos de ingreso y de egreso (RF04, RF12). Los reservados del sistema no se eliminan ni cambian de clase.
CREATE TABLE IF NOT EXISTS motivos_stock (
  id                    INT          AUTO_INCREMENT PRIMARY KEY,
  codigo                VARCHAR(50)  NOT NULL,
  nombre                VARCHAR(100) NOT NULL,
  tipo                  ENUM('ingreso', 'egreso') NOT NULL,
  requiere_autorizacion TINYINT(1)   NOT NULL DEFAULT 0,
  requiere_observacion  TINYINT(1)   NOT NULL DEFAULT 0,
  clase_contable        ENUM('merma', 'sin_asiento', 'otra') NOT NULL DEFAULT 'otra',
  reservado             TINYINT(1)   NOT NULL DEFAULT 0,
  activo                TINYINT(1)   NOT NULL DEFAULT 1,
  CONSTRAINT uq_motivo_stock UNIQUE (codigo)
);
INSERT IGNORE INTO motivos_stock (codigo, nombre, tipo, requiere_autorizacion, requiere_observacion, clase_contable, reservado) VALUES
  ('compra',             'Compra',                         'ingreso', 0, 0, 'otra',        0),
  ('recepcion_sucursal', 'Recepción desde otra sucursal',  'ingreso', 0, 0, 'otra',        0),
  ('devolucion',         'Devolución',                     'ingreso', 0, 0, 'otra',        0),
  ('otros_ingresos',     'Otros ingresos',                 'ingreso', 0, 1, 'otra',        0),
  ('merma_fin_dia',      'Merma de fin de día',            'egreso',  0, 0, 'merma',       0),
  ('rotura',             'Rotura',                         'egreso',  0, 1, 'merma',       0),
  ('vencimiento',        'Vencimiento',                    'egreso',  0, 0, 'merma',       0),
  ('consumo_interno',    'Consumo interno',                'egreso',  0, 0, 'otra',        0),
  ('degustacion',        'Degustación',                    'egreso',  0, 0, 'otra',        0),
  ('robo',               'Robo',                           'egreso',  1, 1, 'otra',        0),
  ('envio_sucursal',     'Envío a sucursal',               'egreso',  0, 0, 'sin_asiento', 0),
  ('devolucion_proveedor', 'Devolución a proveedor',       'egreso',  0, 0, 'sin_asiento', 1),
  ('devolucion_merma',   'Devolución a merma',             'egreso',  0, 0, 'merma',       1),
  ('baja_serie',         'Baja de serie',                  'egreso',  0, 0, 'otra',        1);

-- Cabecera de un ingreso manual (RF04): el comprobante de origen no se registra dos veces (RN09).
CREATE TABLE IF NOT EXISTS stock_ingresos (
  id                  INT          AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  deposito_id         INT          NOT NULL,
  motivo              VARCHAR(50)  NOT NULL,
  proveedor           VARCHAR(150) NULL,
  comprobante_cuit    VARCHAR(11)  NULL,
  comprobante_clase   VARCHAR(10)  NULL,
  comprobante_tipo    VARCHAR(10)  NULL,
  comprobante_pto     SMALLINT UNSIGNED NULL,
  comprobante_numero  VARCHAR(20)  NULL,
  comprobante_cae     VARCHAR(20)  NULL,
  clave_comprobante   VARCHAR(80)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_id             INT          NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ingreso_id_global UNIQUE (id_global),
  CONSTRAINT uq_ingreso_comprobante UNIQUE (clave_comprobante),
  CONSTRAINT fk_ingreso_deposito FOREIGN KEY (deposito_id) REFERENCES depositos(id)
);

-- El libro de movimientos. `cantidad` va con signo y en la unidad base del ítem.
CREATE TABLE IF NOT EXISTS stock_movimientos (
  id                     BIGINT        AUTO_INCREMENT PRIMARY KEY,
  id_global              VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  insumo_id              INT           NULL,
  producto_id            INT           NULL,
  deposito_id            INT           NOT NULL,
  tipo                   ENUM('ingreso', 'egreso', 'transferencia', 'venta', 'devolucion', 'ajuste', 'correccion') NOT NULL,
  motivo                 VARCHAR(50)   NOT NULL,
  cantidad               DECIMAL(14,3) NOT NULL,
  costo_unitario         DECIMAL(14,4) NULL,
  presentacion_id        INT           NULL,
  factor_aplicado        DECIMAL(18,6) NULL,
  cantidad_presentacion  DECIMAL(14,3) NULL,
  documento_tipo         VARCHAR(20)   NULL,
  documento              VARCHAR(60)   NULL,
  movimiento_original_id BIGINT        NULL,
  user_id                INT           NULL,
  observacion            VARCHAR(255)  NULL,
  created_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_mov_id_global      UNIQUE (id_global),
  CONSTRAINT uq_mov_original       UNIQUE (movimiento_original_id),
  CONSTRAINT fk_mov_insumo         FOREIGN KEY (insumo_id)   REFERENCES insumos(id),
  CONSTRAINT fk_mov_producto       FOREIGN KEY (producto_id) REFERENCES productos(id),
  CONSTRAINT fk_mov_deposito       FOREIGN KEY (deposito_id) REFERENCES depositos(id),
  CONSTRAINT ck_mov_un_item        CHECK ((insumo_id IS NULL) <> (producto_id IS NULL)),
  KEY idx_mov_insumo   (insumo_id, deposito_id),
  KEY idx_mov_producto (producto_id, deposito_id),
  KEY idx_mov_documento (documento_tipo, documento),
  KEY idx_mov_fecha (created_at)
);

DROP TRIGGER IF EXISTS stock_movimientos_no_update;
CREATE TRIGGER stock_movimientos_no_update BEFORE UPDATE ON stock_movimientos FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Los movimientos de stock son de solo agregar: se corrigen con un movimiento inverso';
DROP TRIGGER IF EXISTS stock_movimientos_no_delete;
CREATE TRIGGER stock_movimientos_no_delete BEFORE DELETE ON stock_movimientos FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Los movimientos de stock son de solo agregar: se corrigen con un movimiento inverso';

-- Lo que ya había en el campo `stock` entra como saldo inicial en el depósito predeterminado (solo la primera vez).
INSERT INTO stock_movimientos (id_global, insumo_id, deposito_id, tipo, motivo, cantidad, documento_tipo)
SELECT CONCAT('SALDO-INS-', i.id), i.id, (SELECT id FROM depositos WHERE predeterminado = 1 LIMIT 1), 'ajuste', 'saldo_inicial', i.stock, 'inicial'
FROM insumos i WHERE i.stock <> 0 AND NOT EXISTS (SELECT 1 FROM stock_movimientos m WHERE m.insumo_id = i.id);
INSERT INTO stock_movimientos (id_global, producto_id, deposito_id, tipo, motivo, cantidad, documento_tipo)
SELECT CONCAT('SALDO-PRO-', p.id), p.id, (SELECT id FROM depositos WHERE predeterminado = 1 LIMIT 1), 'ajuste', 'saldo_inicial', p.stock, 'inicial'
FROM productos p WHERE p.stock <> 0 AND NOT EXISTS (SELECT 1 FROM stock_movimientos m WHERE m.producto_id = p.id);

-- Nadie cambia el stock a mano: solo el servicio de movimientos (que marca la sesión mientras actualiza el total).
DROP TRIGGER IF EXISTS insumos_stock_solo_por_movimiento;
CREATE TRIGGER insumos_stock_solo_por_movimiento BEFORE UPDATE ON insumos FOR EACH ROW
  IF NEW.stock <> OLD.stock AND COALESCE(@chepola_mov, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'El stock solo cambia con un movimiento';
  END IF;
DROP TRIGGER IF EXISTS productos_stock_solo_por_movimiento;
CREATE TRIGGER productos_stock_solo_por_movimiento BEFORE UPDATE ON productos FOR EACH ROW
  IF NEW.stock <> OLD.stock AND COALESCE(@chepola_mov, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'El stock solo cambia con un movimiento';
  END IF;

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.movimientos.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'stock.movimientos.registrar', 'permitido' UNION ALL
  SELECT 'encargado', 'stock.movimientos.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'stock.movimientos.registrar', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.movimientos.ver', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.movimientos.registrar', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.movimientos.ver', 'permitido' UNION ALL
  SELECT 'produccion', 'stock.movimientos.registrar', 'permitido' UNION ALL
  SELECT 'contador', 'stock.movimientos.ver', 'permitido'
) p ON p.rol = r.codigo;
