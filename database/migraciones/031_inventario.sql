-- C6: alertas, toma de inventario y diferencias de integración (Stock RF14, RF16, RF35, RN20, RN67, RN68, EX50 a EX52).
-- Re-ejecutable: tablas IF NOT EXISTS y semillas con INSERT IGNORE.

-- Una toma de inventario cuenta ítems de un alcance (depósito, categoría o selección). Los ajustes se generan solo al
-- aprobarla y son un delta contra el stock teórico al momento del conteo (RN20).
CREATE TABLE IF NOT EXISTS tomas_inventario (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  id_global        VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado           ENUM('en_curso', 'aprobada', 'cancelada') NOT NULL DEFAULT 'en_curso',
  alcance          VARCHAR(2000) NOT NULL,
  congelar_manual  TINYINT(1)   NOT NULL DEFAULT 0,
  creada_por       INT          NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aprobada_por     INT          NULL,
  aprobada_at      DATETIME     NULL,
  resultado        MEDIUMTEXT   NULL,
  CONSTRAINT uq_toma_id_global UNIQUE (id_global),
  KEY idx_toma_estado (estado)
);

-- Cada línea guarda lo contado, el stock teórico y la marca del último movimiento de su ítem y depósito al cargarla.
CREATE TABLE IF NOT EXISTS toma_lineas (
  id                   INT           AUTO_INCREMENT PRIMARY KEY,
  toma_id              INT           NOT NULL,
  item_tipo            ENUM('insumo', 'producto') NOT NULL,
  item_id              INT           NOT NULL,
  deposito_id          INT           NOT NULL,
  cantidad_contada     DECIMAL(14,3) NOT NULL,
  stock_teorico        DECIMAL(14,3) NOT NULL,
  ultimo_movimiento_id BIGINT        NOT NULL DEFAULT 0,
  contado_at           DATETIME      NOT NULL,
  estado               ENUM('contada', 'aprobada') NOT NULL DEFAULT 'contada',
  marcas               VARCHAR(200)  NULL,
  motivo_confirmacion  VARCHAR(255)  NULL,
  delta_aplicado       DECIMAL(14,3) NULL,
  CONSTRAINT uq_toma_linea UNIQUE (toma_id, item_tipo, item_id, deposito_id),
  CONSTRAINT fk_toma_linea_toma FOREIGN KEY (toma_id) REFERENCES tomas_inventario(id),
  CONSTRAINT fk_toma_linea_dep  FOREIGN KEY (deposito_id) REFERENCES depositos(id)
);

-- Informe "vendido contra descontado" (RF35): cada diferencia queda Abierta hasta resolverse.
CREATE TABLE IF NOT EXISTS diferencias_integracion (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  clave          VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doc_id_global  VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  item_tipo      VARCHAR(10)   NULL,
  item_id        INT           NULL,
  deposito_id    INT           NULL,
  vendido        DECIMAL(14,3) NOT NULL DEFAULT 0,
  descontado     DECIMAL(14,3) NOT NULL DEFAULT 0,
  causa          VARCHAR(40)   NOT NULL,
  estado_mensaje VARCHAR(30)   NULL,
  detalle        VARCHAR(500)  NULL,
  estado         ENUM('abierta', 'resuelta') NOT NULL DEFAULT 'abierta',
  detectada_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resuelta_at    DATETIME      NULL,
  CONSTRAINT uq_diferencia_clave UNIQUE (clave),
  KEY idx_diferencia_estado (estado, causa)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('toma_horas_max_antiguedad', '24'),   -- RN67: un conteo más viejo exige recontar o confirmar
  ('toma_tolerancia_general', '0'),      -- movimientos posteriores tolerados en ítems que no son de control estricto
  ('diferencias_tramite_min', '10');     -- RF35: un mensaje en trámite hace menos de esto no genera alerta

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.inventario.aprobar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'stock.inventario.aprobar', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.inventario.aprobar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
