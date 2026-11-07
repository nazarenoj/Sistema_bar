-- H9: devolución a proveedor y nota de crédito (Compras RF25, RN38, EX24). Re-ejecutable.

-- Las devoluciones que informa Stock (un egreso «Devolución a proveedor»), a la espera de la nota de crédito del proveedor.
CREATE TABLE IF NOT EXISTS cmp_devoluciones (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  egreso_id_global   VARCHAR(60)   NULL,
  ingreso_id_global  VARCHAR(60)   NULL,
  proveedor_id       INT           NULL,
  proveedor_nombre   VARCHAR(150)  NULL,
  item_tipo          VARCHAR(10)   NOT NULL,
  item_id            INT           NOT NULL,
  lote_id            INT           NULL,
  cantidad           DECIMAL(14,3) NOT NULL,
  costo_unitario     DECIMAL(14,4) NULL,
  estado             ENUM('pendiente_nc', 'con_nc') NOT NULL DEFAULT 'pendiente_nc',
  comprobante_id     INT           NULL,
  diferencia_importe DECIMAL(14,2) NULL,
  motivo_diferencia  VARCHAR(255)  NULL,
  ts_ms              BIGINT        NOT NULL,
  CONSTRAINT uq_cmp_devolucion UNIQUE (id_global),
  KEY idx_cmp_devolucion (estado, proveedor_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.devoluciones.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.devoluciones.ver', 'permitido' UNION ALL
  SELECT 'deposito', 'compras.devoluciones.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.devoluciones.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.devoluciones.vincular', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.devoluciones.vincular', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.informes.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.informes.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.informes.ver', 'permitido'
) p ON p.rol = r.codigo;
