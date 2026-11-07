-- H6: listas de precios de proveedor y costo de reposición (Compras RF10, RF11, RF21, RN05 a RN07, RN15, RN27, RN40, EX09, EX10, EX18).
-- Re-ejecutable.

-- El costo de reposición (CR) vigente de cada ítem: neto de IVA computable, bonificaciones y percepciones, por unidad base (RN05). Compras es el dueño.
CREATE TABLE IF NOT EXISTS cmp_costos_reposicion (
  item_tipo              VARCHAR(10)   NOT NULL,
  item_id                INT           NOT NULL,
  costo                  DECIMAL(14,4) NOT NULL,
  moneda                 CHAR(3)       NOT NULL DEFAULT 'ARS',
  fecha                  DATE          NOT NULL,
  fuente                 ENUM('factura', 'lista', 'manual') NOT NULL,
  fuente_ref             VARCHAR(60)   NULL,
  proveedor_principal_id INT           NULL,
  updated_ms             BIGINT        NOT NULL,
  PRIMARY KEY (item_tipo, item_id),
  CONSTRAINT fk_cmp_costo_prov FOREIGN KEY (proveedor_principal_id) REFERENCES cmp_proveedores(id)
);
CREATE TABLE IF NOT EXISTS cmp_costos_historial (
  id          BIGINT        AUTO_INCREMENT PRIMARY KEY,
  item_tipo   VARCHAR(10)   NOT NULL,
  item_id     INT           NOT NULL,
  costo       DECIMAL(14,4) NOT NULL,
  moneda      CHAR(3)       NOT NULL,
  fuente      VARCHAR(10)   NOT NULL,
  fuente_ref  VARCHAR(60)   NULL,
  fecha       DATE          NOT NULL,
  user_id     INT           NULL,
  ts_ms       BIGINT        NOT NULL,
  KEY idx_cmp_costo_hist (item_tipo, item_id, ts_ms)
);
-- Cambios que esperan confirmación: la regla «con confirmación» o una variación mayor al umbral (RN06, EX10).
CREATE TABLE IF NOT EXISTS cmp_costos_pendientes (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  item_tipo        VARCHAR(10)   NOT NULL,
  item_id          INT           NOT NULL,
  costo_propuesto  DECIMAL(14,4) NOT NULL,
  costo_actual     DECIMAL(14,4) NULL,
  variacion_pct    DECIMAL(9,2)  NULL,
  moneda           CHAR(3)       NOT NULL,
  fuente           ENUM('factura', 'lista') NOT NULL,
  fuente_ref       VARCHAR(60)   NULL,
  proveedor_id     INT           NULL,
  motivo           VARCHAR(120)  NOT NULL,
  estado           ENUM('pendiente', 'confirmado', 'rechazado') NOT NULL DEFAULT 'pendiente',
  resuelto_por     INT           NULL,
  ts_ms            BIGINT        NOT NULL,
  KEY idx_cmp_costo_pend (estado, item_tipo, item_id)
);

-- Listas de precios de proveedor (RF10): la vigente y el historial.
CREATE TABLE IF NOT EXISTS cmp_listas_proveedor (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  proveedor_id   INT           NOT NULL,
  nombre         VARCHAR(80)   NOT NULL,
  moneda         CHAR(3)       NOT NULL DEFAULT 'ARS',
  vigente_desde  DATE          NOT NULL,
  vigente_hasta  DATE          NULL,
  estado         ENUM('vigente', 'historica') NOT NULL DEFAULT 'vigente',
  origen         ENUM('manual', 'importada') NOT NULL DEFAULT 'manual',
  user_id        INT           NULL,
  ts_ms          BIGINT        NOT NULL,
  CONSTRAINT fk_cmp_lista_prov FOREIGN KEY (proveedor_id) REFERENCES cmp_proveedores(id),
  KEY idx_cmp_lista_prov (proveedor_id, estado)
);
CREATE TABLE IF NOT EXISTS cmp_lista_lineas (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  lista_id          INT           NOT NULL,
  codigo_proveedor  VARCHAR(60)   NULL,
  item_tipo         VARCHAR(10)   NOT NULL,
  item_id           INT           NOT NULL,
  descripcion       VARCHAR(200)  NULL,
  presentacion_id   INT           NULL,
  factor_aplicado   DECIMAL(18,6) NULL,
  unidad            VARCHAR(30)   NULL,
  precio            DECIMAL(14,4) NOT NULL,
  bonificacion_pct  DECIMAL(5,2)  NOT NULL DEFAULT 0,
  costo_unidad_base DECIMAL(14,4) NOT NULL,
  CONSTRAINT fk_cmp_lista_linea FOREIGN KEY (lista_id) REFERENCES cmp_listas_proveedor(id),
  KEY idx_cmp_lista_linea (lista_id)
);

-- Copia local de Ventas del costo de reposición (Ventas RN81, Compras RN40) y referencia de costo en Stock (Compras RF11): llegan por eventos, nunca se consultan en línea.
CREATE TABLE IF NOT EXISTS ventas_costos_reposicion (
  item_tipo  VARCHAR(10)   NOT NULL,
  item_id    INT           NOT NULL,
  costo      DECIMAL(14,4) NOT NULL,
  moneda     CHAR(3)       NOT NULL,
  fecha      DATE          NOT NULL,
  PRIMARY KEY (item_tipo, item_id)
);
CREATE TABLE IF NOT EXISTS stock_costo_referencia (
  item_tipo  VARCHAR(10)   NOT NULL,
  item_id    INT           NOT NULL,
  costo      DECIMAL(14,4) NOT NULL,
  moneda     CHAR(3)       NOT NULL,
  fecha      DATE          NOT NULL,
  PRIMARY KEY (item_tipo, item_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.costos.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.costos.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.costos.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.costos.editar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.costos.confirmar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.costos.confirmar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.listas.gestionar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.listas.gestionar', 'permitido'
) p ON p.rol = r.codigo;
