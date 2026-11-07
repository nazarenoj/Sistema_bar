-- H4: vencimientos y cuenta corriente de proveedor (Compras RF02, RF05, RN08, RN19).
-- Re-ejecutable.

SET @sql = (
  SELECT IF(COUNT(*) = 0,
    "ALTER TABLE cmp_config ADD COLUMN tramos_antiguedad VARCHAR(40) NOT NULL DEFAULT '30,60,90'",
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'cmp_config' AND column_name = 'tramos_antiguedad'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Una o varias cuotas por comprobante (fecha e importe); el saldo baja cuando una orden de pago las aplica (H5).
CREATE TABLE IF NOT EXISTS cmp_vencimientos (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  comprobante_id  INT           NOT NULL,
  cuota           INT           NOT NULL,
  fecha           DATE          NOT NULL,
  importe         DECIMAL(14,2) NOT NULL,
  saldo           DECIMAL(14,2) NOT NULL,
  estado          ENUM('pendiente', 'pagado', 'anulado') NOT NULL DEFAULT 'pendiente',
  CONSTRAINT fk_cmp_venc_comp FOREIGN KEY (comprobante_id) REFERENCES cmp_comprobantes(id),
  KEY idx_cmp_venc_fecha (estado, fecha),
  KEY idx_cmp_venc_comp (comprobante_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.cuentas.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.cuentas.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.cuentas.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.vencimientos.editar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.vencimientos.editar', 'permitido'
) p ON p.rol = r.codigo;
