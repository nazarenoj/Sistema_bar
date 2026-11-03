-- E8: intereses por mora (CLI-MORA), cuentas en moneda extranjera (CLI-MONEDA-EXT) y retenciones sufridas (CLI-RETENCIONES)
-- (Clientes y CC RF08, RF10, RF11, RN11, RN12, RN13, EX07, EX11). Re-ejecutable: tablas IF NOT EXISTS, ALTER condicionados a su columna centinela, semillas con INSERT IGNORE.

-- Propuestas de ajuste: intereses por mora o diferencia de cambio. Un usuario con permiso las revisa y confirma (emite la nota) o las descarta (condona) con motivo.
CREATE TABLE IF NOT EXISTS propuestas_ajuste_cc (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  cuenta_id        INT           NOT NULL,
  tipo             ENUM('intereses', 'diferencia_cambio') NOT NULL,
  naturaleza       ENUM('debito', 'credito') NOT NULL DEFAULT 'debito',
  movimiento_ref   BIGINT        NOT NULL,
  base_calculo     DECIMAL(14,2) NOT NULL,
  periodo_desde    DATE          NULL,
  periodo_hasta    DATE          NULL,
  importe          DECIMAL(14,2) NOT NULL,
  detalle          VARCHAR(255)  NULL,
  estado           ENUM('pendiente', 'emitida', 'descartada') NOT NULL DEFAULT 'pendiente',
  movimiento_nota  BIGINT        NULL,
  motivo_descarte  VARCHAR(255)  NULL,
  user_id          INT           NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_propuesta_cuenta (cuenta_id, estado),
  KEY idx_propuesta_ref (movimiento_ref, tipo, estado)
);

-- Retenciones sufridas: cancelan deuda igual que un pago (IVA, Ganancias, Ingresos Brutos por jurisdicción, SUSS) y exigen número de certificado.
CREATE TABLE IF NOT EXISTS recibo_retenciones (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  recibo_id       INT           NOT NULL,
  impuesto        ENUM('iva', 'ganancias', 'iibb', 'suss') NOT NULL,
  regimen         VARCHAR(60)   NULL,
  jurisdiccion    VARCHAR(60)   NULL,
  nro_certificado VARCHAR(40)   NOT NULL,
  fecha           DATE          NOT NULL,
  importe         DECIMAL(14,2) NOT NULL,
  CONSTRAINT fk_retencion_recibo FOREIGN KEY (recibo_id) REFERENCES recibos(id),
  KEY idx_retencion_recibo (recibo_id)
);

-- En una cuenta en moneda extranjera el importe del movimiento es el de la cuenta; acá queda el equivalente en pesos del documento y su cotización (RF11).
SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE movimientos_cc ADD COLUMN importe_pesos DECIMAL(14,2) NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'movimientos_cc' AND column_name = 'importe_pesos'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE recibo_valores ADD COLUMN importe_original DECIMAL(14,2) NULL', 'SELECT 1')
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'recibo_valores' AND column_name = 'importe_original'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Con la cotización vencida o ausente: «advertir» usa la última con advertencia y «bloquear» frena la operación (EX07).
INSERT IGNORE INTO parametros (clave, valor) VALUES ('cc_cotizacion_vencida', 'advertir');

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'clientes.ajustes.gestionar' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'clientes.ajustes.gestionar', 'permitido' UNION ALL
  SELECT 'gerente', 'clientes.ajustes.condonar', 'permitido'
) p ON p.rol = r.codigo;
