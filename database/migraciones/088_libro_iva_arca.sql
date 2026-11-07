-- H8: controles contra ARCA (Compras RF14, EX12): importaciones de «Mis Comprobantes» y constataciones del CAE. Re-ejecutable.
-- El Libro IVA Compras (RF13) se genera de los comprobantes; no necesita tablas propias.

CREATE TABLE IF NOT EXISTS cmp_mis_comprobantes_imp (
  id         INT          AUTO_INCREMENT PRIMARY KEY,
  periodo    CHAR(6)      NOT NULL,
  hash       CHAR(64)     NOT NULL,
  cantidad   INT          NOT NULL,
  user_id    INT          NULL,
  ts_ms      BIGINT       NOT NULL,
  UNIQUE KEY uq_cmp_mc_imp (periodo, hash)
);
CREATE TABLE IF NOT EXISTS cmp_mis_comprobantes (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  importacion_id INT           NOT NULL,
  fecha          DATE          NOT NULL,
  tipo_codigo    INT           NOT NULL,
  punto_venta    VARCHAR(5)    NOT NULL,
  numero         VARCHAR(8)    NOT NULL,
  cuit_emisor    VARCHAR(11)   NOT NULL,
  denominacion   VARCHAR(150)  NULL,
  cae            VARCHAR(14)   NULL,
  moneda         VARCHAR(4)    NULL,
  total          DECIMAL(16,2) NOT NULL,
  CONSTRAINT fk_cmp_mc_imp FOREIGN KEY (importacion_id) REFERENCES cmp_mis_comprobantes_imp(id),
  KEY idx_cmp_mc (importacion_id, cuit_emisor, tipo_codigo, punto_venta, numero)
);

-- Cada intento de constatar el CAE de un comprobante recibido.
CREATE TABLE IF NOT EXISTS cmp_constataciones (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  comprobante_id INT           NOT NULL,
  resultado      ENUM('valido', 'no_valido', 'sin_respuesta') NOT NULL,
  detalle        VARCHAR(255)  NULL,
  user_id        INT           NULL,
  ts_ms          BIGINT        NOT NULL,
  CONSTRAINT fk_cmp_const_comp FOREIGN KEY (comprobante_id) REFERENCES cmp_comprobantes(id),
  KEY idx_cmp_const (comprobante_id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'compras.libro_iva.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'compras.libro_iva.ver', 'permitido' UNION ALL
  SELECT 'contador', 'compras.libro_iva.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'compras.arca.controlar', 'permitido' UNION ALL
  SELECT 'administrativo', 'compras.arca.controlar', 'permitido' UNION ALL
  SELECT 'contador', 'compras.arca.controlar', 'permitido'
) p ON p.rol = r.codigo;
