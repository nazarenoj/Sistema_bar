-- G2: formas de pago ↔ caja o cuenta de destino (Financiero RF02) y registro idempotente de cobros (RF17, RF27, RN29 a RN32).
-- Re-ejecutable.

-- Una regla por forma de pago y terminal (terminal_clave = 0 es la regla general). `modo` = 'caja_del_turno': el cobro va a la caja de
-- efectivo asignada a la terminal de la venta (RF02: "el efectivo va a la caja del turno abierto en esa terminal").
CREATE TABLE IF NOT EXISTS fin_destino_forma_pago (
  id                       INT          AUTO_INCREMENT PRIMARY KEY,
  forma_codigo             VARCHAR(50)  NOT NULL,
  terminal_id              INT          NULL,
  terminal_clave           INT          NOT NULL DEFAULT 0,
  modo                     ENUM('cuenta', 'caja_del_turno') NOT NULL DEFAULT 'cuenta',
  cuenta_id                INT          NULL,
  plazo_acreditacion_dias  INT          NOT NULL DEFAULT 0,
  comision_pct             DECIMAL(6,3) NOT NULL DEFAULT 0,
  CONSTRAINT uq_fin_destino UNIQUE (forma_codigo, terminal_clave),
  CONSTRAINT fk_fin_destino_cuenta FOREIGN KEY (cuenta_id) REFERENCES fin_cuentas(id),
  KEY idx_fin_destino_cuenta (cuenta_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'financiero.movimientos.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'financiero.movimientos.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'financiero.movimientos.ver', 'permitido' UNION ALL
  SELECT 'contador', 'financiero.movimientos.ver', 'permitido'
) p ON p.rol = r.codigo;
