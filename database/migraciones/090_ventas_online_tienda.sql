-- I1: Ventas Online, instalación y tienda (Ventas Online RF01, RN01). Re-ejecutable.

-- La tienda de la instancia (una sola por instancia, RN01). `codigo` es la subruta pública: <dominio>/tienda/<codigo>.
CREATE TABLE IF NOT EXISTS onl_tienda (
  id                          TINYINT       NOT NULL PRIMARY KEY,
  codigo                      VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  nombre                      VARCHAR(80)   NULL,
  activa                      TINYINT(1)    NOT NULL DEFAULT 0,
  dominio                     VARCHAR(120)  NULL,
  logo_url                    VARCHAR(255)  NULL,
  color_primario              CHAR(7)       NULL,
  color_acento                CHAR(7)       NULL,
  razon_social                VARCHAR(150)  NULL,
  cuit                        VARCHAR(11)   NULL,
  domicilio                   VARCHAR(200)  NULL,
  telefono                    VARCHAR(40)   NULL,
  email                       VARCHAR(120)  NULL,
  horarios                    TEXT          NULL,
  limite_pedidos_ip_hora      INT           NOT NULL DEFAULT 20,
  vigencia_reserva_min        INT           NOT NULL DEFAULT 15,
  timeout_reserva_segundos    INT           NOT NULL DEFAULT 5,
  impagos_horas               INT           NOT NULL DEFAULT 24,
  disponibilidad_alerta_min   INT           NOT NULL DEFAULT 30,
  prioridad_lista             ENUM('online', 'cliente') NOT NULL DEFAULT 'online',
  CONSTRAINT uq_onl_tienda_codigo UNIQUE (codigo)
);
INSERT IGNORE INTO onl_tienda (id) VALUES (1);

-- Páginas informativas: envíos, cambios y devoluciones, privacidad, términos y condiciones.
CREATE TABLE IF NOT EXISTS onl_paginas (
  slug        VARCHAR(20)   NOT NULL PRIMARY KEY,
  titulo      VARCHAR(100)  NOT NULL,
  contenido   TEXT          NOT NULL,
  updated_ms  BIGINT        NOT NULL
);

INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.tienda.ver' permiso, 'permitido' nivel UNION ALL
  SELECT 'administrativo', 'ventas_online.tienda.ver', 'permitido' UNION ALL
  SELECT 'gerente', 'ventas_online.tienda.configurar', 'permitido'
) p ON p.rol = r.codigo;
