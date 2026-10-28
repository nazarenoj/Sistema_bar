-- Fase A11: reservas con vencimiento (Usuarios RN82, RN83, EX56). Patrón reservar → confirmar → vencer
-- para todo recurso compartido que un módulo toma antes de confirmar su documento (compromiso de venta,
-- reserva online, reserva de crédito, retención de saldo, reserva de clave de comprobante). Cada intento
-- tiene su ID_Solicitud y guarda a qué intento anterior reemplaza.
CREATE TABLE IF NOT EXISTS reservas (
  id_reserva       VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  tipo             VARCHAR(40)  NOT NULL,
  modulo_receptor  VARCHAR(30)  NOT NULL,
  id_solicitud     VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reemplaza_a      VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  recurso          VARCHAR(120) NOT NULL,
  cantidad         DECIMAL(14,3) NOT NULL DEFAULT 0,
  contenido        TEXT         NULL,
  estado           ENUM('vigente', 'consumida', 'liberada', 'vencida') NOT NULL DEFAULT 'vigente',
  vence_ms         BIGINT       NOT NULL,
  renovaciones     INT          NOT NULL DEFAULT 0,
  renovaciones_max INT          NOT NULL DEFAULT 3,
  user_id          INT          NULL,
  creada_ms        BIGINT       NOT NULL,
  cerrada_ms       BIGINT       NULL,
  UNIQUE KEY uq_reservas_solicitud (id_solicitud),
  KEY idx_reservas_recurso (recurso, estado, vence_ms),
  KEY idx_reservas_vence (estado, vence_ms)
);

-- Vigencias por defecto en segundos (RN83), parametrizables.
INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('reserva_vigencia_compromiso_stock', '120'),
  ('reserva_vigencia_reserva_online', '900'),
  ('reserva_vigencia_credito', '300'),
  ('reserva_vigencia_retencion_saldo', '300'),
  ('reserva_vigencia_clave_comprobante', '900'),
  ('reserva_renovaciones_max', '3');
