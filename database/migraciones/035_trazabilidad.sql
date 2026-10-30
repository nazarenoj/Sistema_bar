-- C10: trazabilidad y retiro de lote (Stock RF21, RF42, RN83). Función STK-TRAZA: un retiro bloquea el lote (y, a elección, los
-- lotes elaborados derivados), congela la lista de ventas alcanzadas y lleva el estado de aviso y recupero de cada línea.
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS retiros_lote (
  id                INT          AUTO_INCREMENT PRIMARY KEY,
  id_global         VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lote_id           BIGINT       NOT NULL,
  motivo            VARCHAR(255) NOT NULL,
  incluye_derivados TINYINT(1)   NOT NULL DEFAULT 0,
  estado            ENUM('activo', 'liberado') NOT NULL DEFAULT 'activo',
  user_id           INT          NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  liberado_motivo   VARCHAR(255) NULL,
  liberado_por      INT          NULL,
  liberado_at       DATETIME     NULL,
  CONSTRAINT uq_retiro_id_global UNIQUE (id_global),
  CONSTRAINT fk_retiro_lote FOREIGN KEY (lote_id) REFERENCES lotes(id)
);

-- Lotes bloqueados por el retiro (el origen y, si se pidió, los elaborados derivados).
CREATE TABLE IF NOT EXISTS retiro_lotes (
  retiro_id  INT     NOT NULL,
  lote_id    BIGINT  NOT NULL,
  PRIMARY KEY (retiro_id, lote_id),
  CONSTRAINT fk_retlote_retiro FOREIGN KEY (retiro_id) REFERENCES retiros_lote(id),
  CONSTRAINT fk_retlote_lote   FOREIGN KEY (lote_id)   REFERENCES lotes(id)
);

-- Una línea por movimiento de venta alcanzado. "No confirmado": el lote lo asignó FEFO y pudo ser otro (RN73).
CREATE TABLE IF NOT EXISTS retiro_lineas (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  retiro_id           INT           NOT NULL,
  lote_id             BIGINT        NOT NULL,
  movimiento_id       BIGINT        NOT NULL,
  documento_tipo      VARCHAR(30)   NULL,
  documento           VARCHAR(60)   NULL,
  fecha               DATETIME      NOT NULL,
  deposito_id         INT           NOT NULL,
  cantidad            DECIMAL(14,3) NOT NULL,
  origen_lote         ENUM('indicado', 'fefo') NULL,
  no_confirmado       TINYINT(1)    NOT NULL DEFAULT 0,
  estado_aviso        ENUM('pendiente', 'avisado', 'recuperado') NOT NULL DEFAULT 'pendiente',
  cantidad_recuperada DECIMAL(14,3) NOT NULL DEFAULT 0,
  avisado_por         INT           NULL,
  avisado_at          DATETIME      NULL,
  CONSTRAINT uq_retiro_linea UNIQUE (retiro_id, movimiento_id),
  CONSTRAINT fk_retlinea_retiro FOREIGN KEY (retiro_id) REFERENCES retiros_lote(id)
);

INSERT IGNORE INTO parametros (clave, valor) VALUES ('horas_alerta_aviso_retiro', '4');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'stock.trazabilidad.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'stock.trazabilidad.ver', 'permitido' UNION ALL
  SELECT 'deposito', 'stock.trazabilidad.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'stock.trazabilidad.retirar', 'requiere_autorizacion' UNION ALL
  SELECT 'encargado', 'stock.trazabilidad.retirar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
