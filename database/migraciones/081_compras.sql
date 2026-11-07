-- H1: Compras, instalación, configuración y proveedores (Compras RF01, RF17, RF23, RN02, RN16, RN17, RN18, RN29).
-- Re-ejecutable: tablas IF NOT EXISTS y semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS cmp_config (
  id                        TINYINT       NOT NULL PRIMARY KEY,
  tolerancia_redondeo       DECIMAL(6,2)  NOT NULL DEFAULT 0.05,   -- EX05
  actualizacion_costo       VARCHAR(20)   NOT NULL DEFAULT 'siempre', -- RN06: siempre, solo_si_aumenta o con_confirmacion
  variacion_costo_pct       DECIMAL(6,2)  NOT NULL DEFAULT 20,     -- RN06, EX10
  aviso_vencimiento_dias    INT           NOT NULL DEFAULT 3,      -- RF05
  importe_aprobacion_op     DECIMAL(14,2) NOT NULL DEFAULT 0,      -- RN09 (0 = nunca pide aprobación)
  bloquear_cae_invalido     TINYINT(1)    NOT NULL DEFAULT 0,      -- EX03
  tolerancia_peso_pct       DECIMAL(5,2)  NOT NULL DEFAULT 2,      -- RN24
  retencion_solicitudes_dias INT          NOT NULL DEFAULT 90      -- RN32, RN35
);
INSERT IGNORE INTO cmp_config (id) VALUES (1);

-- Rubros de proveedor (lista configurable, RF17).
CREATE TABLE IF NOT EXISTS cmp_rubros (
  id      INT         AUTO_INCREMENT PRIMARY KEY,
  nombre  VARCHAR(60) NOT NULL,
  activo  TINYINT(1)  NOT NULL DEFAULT 1,
  CONSTRAINT uq_cmp_rubro UNIQUE (nombre)
);
INSERT IGNORE INTO cmp_rubros (nombre) VALUES ('Café y tostadores'), ('Lácteos'), ('Harinas y panificados'), ('Packaging descartable'), ('Bebidas'),
  ('Verdulería y fiambres'), ('Reparto y distribución'), ('Limpieza'), ('Servicios');

-- Proveedores: propios de la instancia (RN18). El CUIT identifica a uno solo (RN02).
CREATE TABLE IF NOT EXISTS cmp_proveedores (
  id                   INT           AUTO_INCREMENT PRIMARY KEY,
  id_global            VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cuit                 VARCHAR(11)   NOT NULL,
  razon_social         VARCHAR(150)  NOT NULL,
  condicion_iva        VARCHAR(40)   NULL,
  domicilio            VARCHAR(200)  NULL,
  contactos            TEXT          NULL,
  cbu_alias            VARCHAR(40)   NULL,
  condicion_pago_dias  INT           NOT NULL DEFAULT 0,
  moneda               CHAR(3)       NOT NULL DEFAULT 'ARS',
  tipo                 ENUM('mercaderia', 'servicios', 'ambos') NOT NULL DEFAULT 'mercaderia',
  retenciones          VARCHAR(60)   NULL,
  rubro_id             INT           NULL,
  plazo_entrega_dias   INT           NULL,
  dias_entrega         SET('lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom') NULL,
  hora_corte           TIME          NULL,
  pedido_minimo        DECIMAL(14,2) NULL,
  verificado_arca      TINYINT(1)    NOT NULL DEFAULT 0,
  estado               ENUM('activo', 'inactivo') NOT NULL DEFAULT 'activo',
  creado_por           INT           NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_cmp_proveedor_id_global UNIQUE (id_global),
  CONSTRAINT uq_cmp_proveedor_cuit UNIQUE (cuit),
  CONSTRAINT fk_cmp_proveedor_rubro FOREIGN KEY (rubro_id) REFERENCES cmp_rubros(id),
  KEY idx_cmp_proveedor_nombre (razon_social)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.proveedores.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'compras.proveedores.gestionar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.proveedores.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.proveedores.gestionar', 'permitido' UNION ALL
  SELECT 'encargado', 'compras.proveedores.ver', 'permitido' UNION ALL
  SELECT 'deposito', 'compras.proveedores.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.proveedores.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.config', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.entrega.editar', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.entrega.editar', 'permitido'
) p ON p.rol = r.codigo;
