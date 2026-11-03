-- E1: maestro de clientes (Clientes y CC RF01, RF02, RF18, RF19, RF21, RN01, RN02, RN22, RN43, EX01 a EX03).
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS clientes (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  id_global          VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tipo_documento     ENUM('DNI', 'CUIT', 'CUIL', 'PASAPORTE', 'CF') NOT NULL,
  nro_documento      VARCHAR(20)  NOT NULL,
  razon_social       VARCHAR(150) NOT NULL,
  tipo_persona       ENUM('fisica', 'juridica') NOT NULL DEFAULT 'fisica',
  condicion_iva      VARCHAR(40)  NULL,
  condicion_iva_receptor_id INT   NULL,
  domicilio_fiscal   VARCHAR(200) NULL,
  telefono           VARCHAR(40)  NULL,
  email              VARCHAR(150) NULL,
  categoria          VARCHAR(40)  NULL,
  tipo_cliente       VARCHAR(30)  NOT NULL DEFAULT 'minorista',
  observaciones      VARCHAR(500) NULL,
  lista_precio_id    INT          NULL,
  ciclo_facturacion  ENUM('a_demanda', 'semanal', 'quincenal', 'mensual') NULL,
  verificado_arca    TINYINT(1)   NOT NULL DEFAULT 0,
  verificado_arca_en DATETIME     NULL,
  origen             VARCHAR(30)  NOT NULL DEFAULT 'local',
  codigo_socio       VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  estado             ENUM('activo', 'inactivo', 'unificado') NOT NULL DEFAULT 'activo',
  id_cliente_resultante INT       NULL,
  creado_por         INT          NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_cliente_id_global UNIQUE (id_global),
  CONSTRAINT uq_cliente_documento UNIQUE (tipo_documento, nro_documento),
  CONSTRAINT uq_cliente_codigo_socio UNIQUE (codigo_socio),
  KEY idx_cliente_nombre (razon_social),
  KEY idx_cliente_telefono (telefono)
);

-- Cliente genérico "Consumidor Final": la única excepción a la unicidad del documento (RN01); no tiene cuenta corriente (RN03).
INSERT IGNORE INTO clientes (id_global, tipo_documento, nro_documento, razon_social, condicion_iva, condicion_iva_receptor_id, tipo_cliente)
VALUES ('CLIENTE-CF', 'CF', '0', 'Consumidor Final', 'Consumidor Final', 5, 'minorista');

CREATE TABLE IF NOT EXISTS cliente_domicilios (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  cliente_id   INT          NOT NULL,
  etiqueta     VARCHAR(60)  NULL,
  direccion    VARCHAR(200) NOT NULL,
  dias_entrega SET('lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom') NULL,
  franja_desde TIME         NULL,
  franja_hasta TIME         NULL,
  CONSTRAINT fk_domicilio_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  KEY idx_domicilio_cliente (cliente_id)
);

-- Unificación de fichas (RF18): la absorbida queda como alias de la resultante (RN43).
CREATE TABLE IF NOT EXISTS cliente_unificaciones (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  absorbido_id  INT          NOT NULL,
  resultante_id INT          NOT NULL,
  motivo        VARCHAR(255) NOT NULL,
  user_id       INT          NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Copia local de Ventas (RN42, Ventas RN81): alias de clientes unificados y datos que Ventas necesita sin consultar en línea.
CREATE TABLE IF NOT EXISTS ventas_cliente_alias (
  alias_id      INT NOT NULL PRIMARY KEY,
  resultante_id INT NOT NULL
);
CREATE TABLE IF NOT EXISTS ventas_clientes_copia (
  cliente_id      INT          NOT NULL PRIMARY KEY,
  razon_social    VARCHAR(150) NOT NULL,
  lista_precio_id INT          NULL,
  socio           TINYINT(1)   NOT NULL DEFAULT 0,
  actualizado_ms  BIGINT       NOT NULL
);

-- Condiciones de los tipos de cliente ("Mayorista" requiere CUIT validado y no puede ser el genérico, RN22).
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'clientes.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'gerente', 'clientes.editar', 'permitido' UNION ALL
  SELECT 'gerente', 'clientes.unificar', 'permitido' UNION ALL
  SELECT 'administrativo', 'clientes.ver', 'permitido' UNION ALL
  SELECT 'administrativo', 'clientes.editar', 'permitido' UNION ALL
  SELECT 'encargado', 'clientes.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'clientes.editar', 'permitido' UNION ALL
  SELECT 'cajero', 'clientes.ver', 'permitido' UNION ALL
  SELECT 'mozo', 'clientes.ver', 'permitido'
) p ON p.rol = r.codigo;
