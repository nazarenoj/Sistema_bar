-- B11: actualización de precios (Ventas RF14, RN17, EX12). Cada actualización guarda los precios anterior y
-- nuevo de cada producto, así se puede ver antes de confirmar (vista previa, sin guardar), programar su
-- vigencia y revertir. Los pedidos abiertos no se tocan: su precio se fijó al agregar el ítem (RN17).

CREATE TABLE IF NOT EXISTS actualizaciones_precio (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  id_global      VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo           ENUM('porcentaje', 'monto', 'importacion') NOT NULL,
  valor          DECIMAL(10,2) NULL,
  filtro         VARCHAR(500)  NULL,
  estado         ENUM('programada', 'aplicada', 'revertida', 'cancelada') NOT NULL,
  vigencia_desde DATETIME      NULL,
  motivo         VARCHAR(255)  NULL,
  creada_por     INT           NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aplicada_at    DATETIME      NULL,
  revertida_at   DATETIME      NULL,
  CONSTRAINT uq_actualizacion_id_global UNIQUE (id_global),
  KEY idx_actualizacion_pendiente (estado, vigencia_desde)
);

CREATE TABLE IF NOT EXISTS actualizacion_precio_items (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  actualizacion_id  INT           NOT NULL,
  producto_id       INT           NOT NULL,
  nombre            VARCHAR(255)  NOT NULL,
  precio_anterior   DECIMAL(10,2) NOT NULL,
  precio_nuevo      DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_apitem_actualizacion FOREIGN KEY (actualizacion_id) REFERENCES actualizaciones_precio(id),
  CONSTRAINT fk_apitem_producto      FOREIGN KEY (producto_id)      REFERENCES productos(id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas.precios.actualizar' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas.precios.actualizar', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
