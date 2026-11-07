-- G7: gastos, gastos recurrentes, gasto con comprobante fiscal y pago de comisiones (Financiero RF10, RF12, RF23, RN13, RN25, EX12, EX26).
-- Re-ejecutable.

CREATE TABLE IF NOT EXISTS fin_gastos (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fecha              DATE          NOT NULL,
  categoria_id       INT           NOT NULL,
  cuenta_id          INT           NOT NULL,
  importe            DECIMAL(14,2) NOT NULL,
  moneda             CHAR(3)       NOT NULL DEFAULT 'ARS',
  descripcion        VARCHAR(255)  NULL,
  proveedor          VARCHAR(150)  NULL,
  estado             ENUM('borrador', 'confirmado', 'anulado') NOT NULL DEFAULT 'confirmado',
  origen             ENUM('manual', 'recurrente', 'comision', 'foto') NOT NULL DEFAULT 'manual',
  fiscal             TINYINT(1)    NOT NULL DEFAULT 0,
  comprobante        TEXT          NULL,
  clave              VARCHAR(190)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  id_reserva         VARCHAR(80)   NULL,
  adjunto_nombre     VARCHAR(120)  NULL,
  adjunto_tipo       VARCHAR(60)   NULL,
  adjunto            MEDIUMBLOB    NULL,
  recurrente_id      INT           NULL,
  recurrente_fecha   DATE          NULL,
  movimiento_id      BIGINT        NULL,
  motivo_anulacion   VARCHAR(255)  NULL,
  user_id            INT           NULL,
  ts_ms              BIGINT        NOT NULL,
  CONSTRAINT uq_fin_gasto_id_global UNIQUE (id_global),
  CONSTRAINT uq_fin_gasto_recurrente UNIQUE (recurrente_id, recurrente_fecha),
  CONSTRAINT fk_fin_gasto_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  CONSTRAINT fk_fin_gasto_categoria FOREIGN KEY (categoria_id) REFERENCES fin_categorias(id),
  KEY idx_fin_gasto_fecha (fecha),
  KEY idx_fin_gasto_clave (clave)
);

-- Gastos periódicos (alquiler, abonos, servicios): importe estimado, periodicidad y próxima fecha (RF12, FIN-GASTOS-REC).
CREATE TABLE IF NOT EXISTS fin_gastos_recurrentes (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  nombre             VARCHAR(80)   NOT NULL,
  categoria_id       INT           NOT NULL,
  cuenta_id          INT           NOT NULL,
  importe_estimado   DECIMAL(14,2) NOT NULL,
  periodicidad       ENUM('semanal', 'mensual', 'bimestral', 'trimestral', 'semestral', 'anual') NOT NULL DEFAULT 'mensual',
  proxima_fecha      DATE          NOT NULL,
  dia_mes            TINYINT       NOT NULL DEFAULT 1,
  aviso_dias         INT           NOT NULL DEFAULT 3,
  activo             TINYINT(1)    NOT NULL DEFAULT 1,
  CONSTRAINT uq_fin_gasto_rec_nombre UNIQUE (nombre),
  CONSTRAINT fk_fin_gasto_rec_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  CONSTRAINT fk_fin_gasto_rec_categoria FOREIGN KEY (categoria_id) REFERENCES fin_categorias(id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.gastos.registrar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'financiero.gastos.registrar', 'permitido' UNION ALL
  SELECT 'encargado', 'financiero.gastos.registrar', 'permitido' UNION ALL
  SELECT 'cajero', 'financiero.gastos.registrar', 'requiere_autorizacion' UNION ALL
  SELECT 'gerente', 'financiero.gastos.anular', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.gastos.anular', 'requiere_autorizacion' UNION ALL
  SELECT 'gerente', 'financiero.gastos.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.gastos.ver', 'permitido' UNION ALL
  SELECT 'contador', 'financiero.gastos.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'financiero.gastos.ver', 'permitido'
) p ON p.rol = r.codigo;
