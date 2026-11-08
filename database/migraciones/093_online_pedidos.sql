-- I5: checkout y reserva de stock (Ventas Online RF09, RF24, RN05, RN06, RN07, RN45, RN48, RN49, EX01, EX09, EX14, EX27 a EX30). Re-ejecutable.

CREATE TABLE IF NOT EXISTS onl_pedidos (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  id_global           VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id_solicitud        VARCHAR(64)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado              VARCHAR(30)   NOT NULL DEFAULT 'pendiente_pago',
  cuenta_id           INT           NULL,
  nombre              VARCHAR(100)  NOT NULL,
  email               VARCHAR(120)  NOT NULL,
  telefono            VARCHAR(40)   NULL,
  facturacion         TEXT          NOT NULL,
  entrega_tipo        VARCHAR(20)   NOT NULL DEFAULT 'retiro',
  entrega_datos       TEXT          NULL,
  medio_pago          VARCHAR(30)   NOT NULL,
  subtotal            DECIMAL(12,2) NOT NULL,
  descuento           DECIMAL(12,2) NOT NULL DEFAULT 0,
  envio               DECIMAL(12,2) NOT NULL DEFAULT 0,
  total               DECIMAL(12,2) NOT NULL,
  canje_importe       DECIMAL(12,2) NOT NULL DEFAULT 0,
  a_pagar             DECIMAL(12,2) NOT NULL,
  cupon_id            INT           NULL,
  cupon_codigo        VARCHAR(40)   NULL,
  reserva_id          VARCHAR(60)   NULL,
  reserva_estado      VARCHAR(20)   NOT NULL DEFAULT 'no_aplica',
  reserva_vence_ms    BIGINT        NULL,
  reserva_renovaciones INT          NOT NULL DEFAULT 0,
  reserva_intento     INT           NOT NULL DEFAULT 1,
  credito_reserva_id  VARCHAR(80)   NULL,
  retencion_id        VARCHAR(80)   NULL,
  canje_datos         TEXT          NULL,
  config_version      INT           NULL,
  config_instantanea  TEXT          NULL,
  terminos_ms         BIGINT        NOT NULL,
  observaciones       VARCHAR(255)  NULL,
  motivo_cancelacion  VARCHAR(255)  NULL,
  created_ms          BIGINT        NOT NULL,
  pagado_ms           BIGINT        NULL,
  updated_ms          BIGINT        NOT NULL,
  CONSTRAINT uq_onl_pedido_global UNIQUE (id_global),
  CONSTRAINT uq_onl_pedido_solicitud UNIQUE (id_solicitud),
  KEY idx_onl_pedido_estado (estado, created_ms),
  KEY idx_onl_pedido_cuenta (cuenta_id),
  KEY idx_onl_pedido_reserva (reserva_estado, reserva_vence_ms)
);
CREATE TABLE IF NOT EXISTS onl_pedido_lineas (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  pedido_id       INT           NOT NULL,
  linea           INT           NOT NULL,
  producto_id     INT           NOT NULL,
  titulo          VARCHAR(160)  NOT NULL,
  cantidad        DECIMAL(12,3) NOT NULL,
  precio_unitario DECIMAL(12,2) NOT NULL,
  importe         DECIMAL(12,2) NOT NULL,
  opciones        TEXT          NULL,
  alergenos       TEXT          NULL,
  observaciones   VARCHAR(255)  NULL,
  lista           VARCHAR(80)   NULL,
  CONSTRAINT fk_onl_linea_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id),
  KEY idx_onl_linea_pedido (pedido_id)
);
CREATE TABLE IF NOT EXISTS onl_pedido_historial (
  id        BIGINT        AUTO_INCREMENT PRIMARY KEY,
  pedido_id INT           NOT NULL,
  estado    VARCHAR(30)   NOT NULL,
  detalle   VARCHAR(255)  NULL,
  user_id   INT           NULL,
  ts_ms     BIGINT        NOT NULL,
  CONSTRAINT fk_onl_hist_pedido FOREIGN KEY (pedido_id) REFERENCES onl_pedidos(id),
  KEY idx_onl_hist_pedido (pedido_id, id)
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.pedidos.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'ventas_online.pedidos.ver', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas_online.pedidos.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.pedidos.gestionar', 'permitido' UNION ALL
  SELECT 'encargado', 'ventas_online.pedidos.gestionar', 'permitido'
) p ON p.rol = r.codigo;
