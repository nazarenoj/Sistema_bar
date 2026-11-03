-- E7: fidelización, gift cards, saldo a favor y vales (Clientes y CC RF22 a RF24, RF29, RF31, RN23 a RN31, EX13 a EX17, EX30, EX31, EX33, EX34; Ventas RF49, RF51, RN76, RN77).
-- Función CLI-FIDEL. Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionados a su columna centinela, triggers con DROP IF EXISTS, semillas con INSERT IGNORE.

-- Programa de la instancia (una ficha): los saldos pertenecen a la sucursal donde se acumularon y no se consolidan (RN26).
CREATE TABLE IF NOT EXISTS fid_programa (
  id                 INT           NOT NULL PRIMARY KEY,
  nombre             VARCHAR(100)  NOT NULL DEFAULT 'Programa de fidelización',
  estado             ENUM('activo', 'inactivo') NOT NULL DEFAULT 'inactivo',
  vigente_desde      DATE          NULL,
  vigente_hasta      DATE          NULL,
  importe_por_punto  DECIMAL(12,2) NOT NULL DEFAULT 1000,
  valor_punto        DECIMAL(10,2) NOT NULL DEFAULT 1,
  redondeo           ENUM('abajo', 'arriba', 'cercano') NOT NULL DEFAULT 'abajo',
  tope_puntos_venta  INT           NULL,
  venc_sellos_dias   INT           NULL,
  venc_puntos_dias   INT           NULL,
  venc_saldo_dias    INT           NULL,
  venc_giftcard_dias INT           NULL,
  venc_vale_dias     INT           NULL,
  venc_base          ENUM('emision', 'actividad') NOT NULL DEFAULT 'emision',
  aviso_dias         INT           NOT NULL DEFAULT 15
);
INSERT IGNORE INTO fid_programa (id) VALUES (1);

-- Reglas de sellos por artículo o categoría: tantos sellos por unidad y, al completar, un premio (producto gratis o descuento fijo).
CREATE TABLE IF NOT EXISTS fid_reglas_sellos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  nombre             VARCHAR(100)  NOT NULL,
  producto_id        INT           NULL,
  categoria_id       INT           NULL,
  sellos_por_unidad  INT           NOT NULL DEFAULT 1,
  sellos_para_premio INT           NOT NULL,
  premio_tipo        ENUM('producto_gratis', 'descuento_fijo') NOT NULL,
  premio_producto_id INT           NULL,
  premio_importe     DECIMAL(12,2) NULL,
  tope_sellos_venta  INT           NULL,
  activa             TINYINT(1)    NOT NULL DEFAULT 1
);

-- Adhesión del cliente con su consentimiento (fecha y usuario). La baja detiene nuevas acumulaciones; los saldos siguen canjeables hasta vencer (RN23).
CREATE TABLE IF NOT EXISTS fid_socios (
  cliente_id          INT         NOT NULL PRIMARY KEY,
  estado              ENUM('activo', 'baja') NOT NULL DEFAULT 'activo',
  consentimiento_en   DATETIME    NOT NULL,
  consentimiento_user INT         NULL,
  baja_en             DATETIME    NULL,
  CONSTRAINT fk_socio_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

-- Movimientos de sellos y puntos: no se editan ni se borran; el saldo es la suma (RN28). Puede quedar negativo tras una reversión (EX17).
CREATE TABLE IF NOT EXISTS fid_movimientos (
  id              BIGINT        AUTO_INCREMENT PRIMARY KEY,
  cliente_id      INT           NOT NULL,
  tipo            ENUM('sellos', 'puntos') NOT NULL,
  movimiento      ENUM('acumulacion', 'canje', 'ajuste', 'reversion', 'vencimiento', 'reactivacion') NOT NULL,
  cantidad        DECIMAL(14,2) NOT NULL,
  regla_id        INT           NULL,
  venta_id_global VARCHAR(60)   NULL,
  id_operacion    VARCHAR(160)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  motivo          VARCHAR(255)  NULL,
  user_id         INT           NULL,
  terminal        VARCHAR(40)   NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_fid_mov_operacion UNIQUE (id_operacion),
  KEY idx_fid_mov_cliente (cliente_id, tipo, created_at),
  KEY idx_fid_mov_venta (venta_id_global)
);

-- Instrumentos de valor con código único (que lleva la instancia emisora, RN26): gift card, saldo a favor (monedero) y vale por devolución.
CREATE TABLE IF NOT EXISTS fid_instrumentos (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  codigo           VARCHAR(60)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo             ENUM('gift_card', 'saldo_favor', 'vale') NOT NULL,
  cliente_id       INT           NULL,
  importe_inicial  DECIMAL(14,2) NOT NULL,
  estado           ENUM('vigente', 'agotado', 'vencido', 'anulado') NOT NULL DEFAULT 'vigente',
  vence_en         DATE          NULL,
  instancia        VARCHAR(10)   NOT NULL,
  venta_id_global  VARCHAR(60)   NULL,
  devolucion_id    VARCHAR(60)   NULL,
  nc_id            VARCHAR(60)   NULL,
  importe_devuelto DECIMAL(14,2) NULL,
  ultima_actividad DATE          NOT NULL,
  avisado_vencimiento TINYINT(1) NOT NULL DEFAULT 0,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_instrumento_codigo UNIQUE (codigo),
  KEY idx_instrumento_cliente (cliente_id),
  KEY idx_instrumento_estado (estado, vence_en)
);

CREATE TABLE IF NOT EXISTS fid_instrumento_movs (
  id              BIGINT        AUTO_INCREMENT PRIMARY KEY,
  instrumento_id  INT           NOT NULL,
  movimiento      ENUM('emision', 'canje', 'ajuste', 'reversion', 'vencimiento', 'reactivacion', 'anulacion') NOT NULL,
  importe         DECIMAL(14,2) NOT NULL,
  venta_id_global VARCHAR(60)   NULL,
  id_operacion    VARCHAR(160)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  motivo          VARCHAR(255)  NULL,
  user_id         INT           NULL,
  terminal        VARCHAR(40)   NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_instrumento_mov_operacion UNIQUE (id_operacion),
  CONSTRAINT fk_instrumento_mov FOREIGN KEY (instrumento_id) REFERENCES fid_instrumentos(id),
  KEY idx_instrumento_mov (instrumento_id)
);

DROP TRIGGER IF EXISTS fid_movimientos_no_editar;
CREATE TRIGGER fid_movimientos_no_editar BEFORE UPDATE ON fid_movimientos FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de fidelización no se edita: se corrige con un contramovimiento';
DROP TRIGGER IF EXISTS fid_movimientos_no_borrar;
CREATE TRIGGER fid_movimientos_no_borrar BEFORE DELETE ON fid_movimientos FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de fidelización no se elimina: se corrige con un contramovimiento';
DROP TRIGGER IF EXISTS fid_instrumento_movs_no_editar;
CREATE TRIGGER fid_instrumento_movs_no_editar BEFORE UPDATE ON fid_instrumento_movs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de un instrumento no se edita: se corrige con un contramovimiento';
DROP TRIGGER IF EXISTS fid_instrumento_movs_no_borrar;
CREATE TRIGGER fid_instrumento_movs_no_borrar BEFORE DELETE ON fid_instrumento_movs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Un movimiento de un instrumento no se elimina: se corrige con un contramovimiento';

-- Retención de saldo para un canje (reservar, confirmar y vencer): atómica por instrumento; dura 5 minutos (parametrizable).
CREATE TABLE IF NOT EXISTS fid_retenciones (
  id_retencion   VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  tipo           ENUM('instrumento', 'puntos') NOT NULL,
  instrumento_id INT           NULL,
  cliente_id     INT           NULL,
  importe        DECIMAL(14,2) NOT NULL,
  puntos         DECIMAL(14,2) NULL,
  id_solicitud   VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reemplaza_a    VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  estado         ENUM('vigente', 'consumida', 'liberada', 'vencida') NOT NULL DEFAULT 'vigente',
  vence_ms       BIGINT        NOT NULL,
  renovaciones   INT           NOT NULL DEFAULT 0,
  created_ms     BIGINT        NOT NULL,
  CONSTRAINT uq_retencion_solicitud UNIQUE (id_solicitud),
  KEY idx_retencion_instrumento (instrumento_id, estado, vence_ms),
  KEY idx_retencion_cliente (cliente_id, estado, vence_ms)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('fid_retencion_minutos', '5');

-- Ventas: artículo tipo «Gift card» (precio fijo o libre, sin stock), promociones solo para socios, la forma de pago de canje y los datos del canje en el pago.
SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE productos MODIFY tipo ENUM('estandar','variante','pesable','fraccionable','combo','elaborado','servicio','serializado','gift_card') NOT NULL DEFAULT 'estandar'", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'productos' AND column_name = 'tipo' AND column_type LIKE '%gift_card%'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE promociones ADD COLUMN solo_socios TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'promociones' AND column_name = 'solo_socios'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE pago_venta ADD COLUMN instrumento VARCHAR(80) NULL, ADD COLUMN retencion_id VARCHAR(40) NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pago_venta' AND column_name = 'retencion_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO formas_pago (codigo, nombre, requiere_referencia, admite_vuelto, orden) VALUES ('vale', 'Vale / Gift card / Puntos', 0, 0, 91);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'clientes.fidelizacion.configurar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'clientes.fidelizacion.gestionar', 'permitido' UNION ALL
  SELECT 'administrativo', 'clientes.fidelizacion.gestionar', 'permitido' UNION ALL
  SELECT 'encargado', 'clientes.fidelizacion.gestionar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
