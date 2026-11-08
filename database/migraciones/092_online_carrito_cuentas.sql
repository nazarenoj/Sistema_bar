-- I4: carrito, cupones y cuentas de cliente (Ventas Online RF06, RF07, RF08, RN23, RN47, EX10, EX12, EX14). Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_tienda ADD COLUMN carrito_dias INT NOT NULL DEFAULT 7, ADD COLUMN envio_gratis_desde DECIMAL(12,2) NULL",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'carrito_dias'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cuentas de la tienda (correo y contraseña). `cliente_id` es la ficha de Clientes y CC cuando hay vínculo (RN18, RN47).
CREATE TABLE IF NOT EXISTS onl_clientes (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  email           VARCHAR(120)  NOT NULL,
  password_hash   VARCHAR(100)  NOT NULL,
  nombre          VARCHAR(100)  NOT NULL,
  telefono        VARCHAR(40)   NULL,
  direcciones     TEXT          NULL,
  datos_fiscales  TEXT          NULL,
  cliente_id      INT           NULL,
  activo          TINYINT(1)    NOT NULL DEFAULT 1,
  reset_hash      CHAR(64)      NULL,
  reset_vence_ms  BIGINT        NULL,
  creado_ms       BIGINT        NOT NULL,
  CONSTRAINT uq_onl_cliente_email UNIQUE (email)
);

-- Carritos de invitados y de clientes registrados; se guardan N días (carrito_dias).
CREATE TABLE IF NOT EXISTS onl_carritos (
  token           CHAR(48)      CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  cliente_online_id INT         NULL,
  items           MEDIUMTEXT    NOT NULL,
  cupon           VARCHAR(40)   NULL,
  creado_ms       BIGINT        NOT NULL,
  actualizado_ms  BIGINT        NOT NULL,
  vence_ms        BIGINT        NOT NULL,
  KEY idx_onl_carrito_vence (vence_ms),
  KEY idx_onl_carrito_cliente (cliente_online_id)
);

CREATE TABLE IF NOT EXISTS onl_cupones (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  codigo            VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  descripcion       VARCHAR(120)  NULL,
  tipo              ENUM('porcentaje', 'monto') NOT NULL,
  valor             DECIMAL(12,2) NOT NULL,
  minimo_compra     DECIMAL(12,2) NOT NULL DEFAULT 0,
  vigente_desde     DATE          NULL,
  vigente_hasta     DATE          NULL,
  usos_max          INT           NULL,
  usos_por_cliente  INT           NULL,
  usos              INT           NOT NULL DEFAULT 0,
  alcance_tipo      ENUM('todo', 'articulos', 'categorias') NOT NULL DEFAULT 'todo',
  alcance           TEXT          NULL,
  acumulable        TINYINT(1)    NOT NULL DEFAULT 0,
  activo            TINYINT(1)    NOT NULL DEFAULT 1,
  CONSTRAINT uq_onl_cupon_codigo UNIQUE (codigo)
);
-- Un uso por pedido confirmado; `quien` es la cuenta (c:ID) o el correo del invitado.
CREATE TABLE IF NOT EXISTS onl_cupon_usos (
  id        INT          AUTO_INCREMENT PRIMARY KEY,
  cupon_id  INT          NOT NULL,
  quien     VARCHAR(140) NOT NULL,
  pedido_id VARCHAR(40)  NOT NULL,
  importe   DECIMAL(12,2) NOT NULL,
  ts_ms     BIGINT       NOT NULL,
  CONSTRAINT uq_onl_cupon_uso UNIQUE (cupon_id, pedido_id),
  CONSTRAINT fk_onl_cupon_uso FOREIGN KEY (cupon_id) REFERENCES onl_cupones(id),
  KEY idx_onl_cupon_quien (cupon_id, quien)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.cupones.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'ventas_online.clientes.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'ventas_online.clientes.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.clientes.vincular', 'permitido'
) p ON p.rol = r.codigo;
