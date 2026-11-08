-- I11: marketplaces y plataformas, reservas desde la tienda, informes e indicadores (Ventas Online RF17 a RF20, RF28, RN25 a RN31, EX15 a EX19; Financiero RF24). Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_pedidos ADD COLUMN origen VARCHAR(12) NOT NULL DEFAULT 'tienda', ADD COLUMN conector_id INT NULL, ADD COLUMN id_externo VARCHAR(80) NULL, ADD COLUMN comision DECIMAL(12,2) NOT NULL DEFAULT 0, ADD CONSTRAINT uq_onl_pedido_externo UNIQUE (conector_id, id_externo)",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_pedidos' AND column_name = 'origen'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_tienda ADD COLUMN reservas_confirmacion VARCHAR(10) NOT NULL DEFAULT 'auto', ADD COLUMN reservas_cancelar_horas INT NOT NULL DEFAULT 2",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_tienda' AND column_name = 'reservas_confirmacion'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE onl_publicados ADD COLUMN por_encargo TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN anticipacion_min_h INT NOT NULL DEFAULT 0, ADD COLUMN anticipacion_max_dias INT NULL, ADD COLUMN cupo_diario_encargos INT NULL",
    'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'onl_publicados' AND column_name = 'por_encargo'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Las reservas y los encargos de Ventas saben de dónde vinieron (RF20).
SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE reservas_mesa ADD COLUMN origen VARCHAR(12) NOT NULL DEFAULT 'local'", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'reservas_mesa' AND column_name = 'origen'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SET @sql = (
  SELECT IF(COUNT(*) = 0, "ALTER TABLE pedidos_especiales ADD COLUMN origen VARCHAR(12) NOT NULL DEFAULT 'local'", 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'pedidos_especiales' AND column_name = 'origen'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Conectores de marketplaces y plataformas de delivery (RF18).
CREATE TABLE IF NOT EXISTS onl_conectores (
  id                   INT           AUTO_INCREMENT PRIMARY KEY,
  codigo               VARCHAR(30)   CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  nombre               VARCHAR(80)   NOT NULL,
  comision_pct         DECIMAL(5,2)  NOT NULL DEFAULT 0,
  lista_precio_id      INT           NULL,
  ajuste_pct           DECIMAL(6,2)  NOT NULL DEFAULT 0,
  aceptacion_auto      TINYINT(1)    NOT NULL DEFAULT 1,
  acepta_minutos       INT           NOT NULL DEFAULT 2,
  pausado              TINYINT(1)    NOT NULL DEFAULT 0,
  pausa_motivo         VARCHAR(160)  NULL,
  token_hash           CHAR(64)      NOT NULL,
  conexion             VARCHAR(16)   NOT NULL DEFAULT 'conectado',
  ultima_publicacion_ms BIGINT       NULL,
  activo               TINYINT(1)    NOT NULL DEFAULT 1,
  CONSTRAINT uq_onl_conector_codigo UNIQUE (codigo)
);
CREATE TABLE IF NOT EXISTS onl_conector_articulos (
  conector_id  INT          NOT NULL,
  producto_id  INT          NOT NULL,
  id_externo   VARCHAR(80)  NOT NULL,
  PRIMARY KEY (conector_id, producto_id),
  CONSTRAINT uq_onl_conector_externo UNIQUE (conector_id, id_externo),
  CONSTRAINT fk_onl_ca_conector FOREIGN KEY (conector_id) REFERENCES onl_conectores(id),
  CONSTRAINT fk_onl_ca_producto FOREIGN KEY (producto_id) REFERENCES productos(id)
);
-- Cambios de estado que se informan a la plataforma (En preparación, Listo, Despachado): se reintentan si no hay conexión.
CREATE TABLE IF NOT EXISTS onl_conector_eventos (
  id          BIGINT        AUTO_INCREMENT PRIMARY KEY,
  conector_id INT           NOT NULL,
  pedido_id   INT           NOT NULL,
  evento      VARCHAR(30)   NOT NULL,
  estado      VARCHAR(12)   NOT NULL DEFAULT 'pendiente',
  intentos    INT           NOT NULL DEFAULT 0,
  error       VARCHAR(255)  NULL,
  ts_ms       BIGINT        NOT NULL,
  KEY idx_onl_ce (estado, conector_id)
);

-- Reservas hechas desde la tienda (RF20): la fuente es la función Reservas de Ventas; acá queda el enlace con el cliente.
CREATE TABLE IF NOT EXISTS onl_reservas (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  token       CHAR(32)      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo        VARCHAR(10)   NOT NULL,
  ref_id      INT           NOT NULL,
  inscripto_id INT          NULL,
  nombre      VARCHAR(120)  NOT NULL,
  email       VARCHAR(120)  NOT NULL,
  estado      VARCHAR(12)   NOT NULL DEFAULT 'pendiente',
  fecha_ms    BIGINT        NOT NULL,
  creado_ms   BIGINT        NOT NULL,
  CONSTRAINT uq_onl_reserva_token UNIQUE (token)
);

-- Visitas a la tienda pública (RF17, RF28: conversión).
CREATE TABLE IF NOT EXISTS onl_visitas (
  dia      DATE  NOT NULL PRIMARY KEY,
  visitas  INT   NOT NULL DEFAULT 0
);

-- Financiero recibe las comisiones y las liquidaciones de las plataformas (Financiero RF24, Ventas Online RN28): idempotentes por su ID_Operacion / ID_Liquidacion.
CREATE TABLE IF NOT EXISTS fin_plataforma_comisiones (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  id_operacion  VARCHAR(120)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plataforma    VARCHAR(30)   NOT NULL,
  pedido_global VARCHAR(40)   NOT NULL,
  id_externo    VARCHAR(80)   NOT NULL,
  bruto         DECIMAL(12,2) NOT NULL,
  comision      DECIMAL(12,2) NOT NULL,
  fecha         DATE          NOT NULL,
  liquidacion_id INT          NULL,
  CONSTRAINT uq_fin_pc_operacion UNIQUE (id_operacion),
  KEY idx_fin_pc (plataforma, fecha)
);
CREATE TABLE IF NOT EXISTS fin_plataforma_liquidaciones (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  id_liquidacion VARCHAR(80)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plataforma     VARCHAR(30)   NOT NULL,
  desde          DATE          NOT NULL,
  hasta          DATE          NOT NULL,
  bruto          DECIMAL(12,2) NOT NULL,
  comision       DECIMAL(12,2) NOT NULL,
  neto           DECIMAL(12,2) NOT NULL,
  esperado_bruto DECIMAL(12,2) NULL,
  esperado_comision DECIMAL(12,2) NULL,
  estado         VARCHAR(16)   NOT NULL DEFAULT 'pendiente',
  nota           VARCHAR(255)  NULL,
  recibida_ms    BIGINT        NOT NULL,
  CONSTRAINT uq_fin_pl_liquidacion UNIQUE (id_liquidacion)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.plataformas.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'ventas_online.reservas.gestionar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas_online.reservas.gestionar', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.informes.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'ventas_online.informes.ver', 'permitido' UNION ALL
  SELECT 'contador', 'ventas_online.informes.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'financiero.plataformas.ver', 'permitido' UNION ALL
  SELECT 'contador', 'financiero.plataformas.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'financiero.plataformas.resolver', 'permitido'
) p ON p.rol = r.codigo;
