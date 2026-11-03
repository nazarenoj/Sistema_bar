-- D8: reservas de mesa, lista de espera, turnos con cupo y pedidos especiales (Ventas RF43, RF44, RN40, EX30). Función VEN-RESERVAS.
-- Re-ejecutable: tablas IF NOT EXISTS, semillas con INSERT IGNORE.

CREATE TABLE IF NOT EXISTS reservas_mesa (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  id_global        VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fecha_hora       DATETIME     NOT NULL,
  duracion_min     INT          NOT NULL,
  fecha_fin        DATETIME     NOT NULL,
  personas         INT          NOT NULL,
  salon_id         INT          NULL,
  mesa_id          INT          NULL,
  cliente_nombre   VARCHAR(120) NOT NULL,
  cliente_telefono VARCHAR(40)  NULL,
  cliente_email    VARCHAR(150) NULL,
  cliente_id       INT          NULL,
  estado           ENUM('pendiente', 'confirmada', 'cumplida', 'no_presento', 'cancelada') NOT NULL DEFAULT 'pendiente',
  en_espera        TINYINT(1)   NOT NULL DEFAULT 0,
  observaciones    VARCHAR(255) NULL,
  motivo_cancelacion VARCHAR(255) NULL,
  recordatorio_enviado_at DATETIME NULL,
  creada_por       INT          NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_reserva_id_global UNIQUE (id_global),
  KEY idx_reserva_mesa (mesa_id, fecha_hora, fecha_fin),
  KEY idx_reserva_estado (estado, fecha_hora)
);

-- Talleres y catas con cupo (RF44).
CREATE TABLE IF NOT EXISTS turnos_servicio (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(120) NOT NULL,
  tipo           ENUM('taller', 'cata') NOT NULL,
  fecha_hora     DATETIME     NOT NULL,
  cupo           INT          NOT NULL,
  responsable_id INT          NULL,
  detalle        VARCHAR(500) NULL,
  cancelado      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_turno_fecha (fecha_hora)
);
CREATE TABLE IF NOT EXISTS turno_inscriptos (
  id        INT          AUTO_INCREMENT PRIMARY KEY,
  turno_id  INT          NOT NULL,
  nombre    VARCHAR(120) NOT NULL,
  telefono  VARCHAR(40)  NULL,
  personas  INT          NOT NULL DEFAULT 1,
  activo    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ti_turno (turno_id),
  CONSTRAINT fk_ti_turno FOREIGN KEY (turno_id) REFERENCES turnos_servicio(id)
);

-- Pedidos especiales con fecha de entrega (tortas por encargo, catering, bandejas). Sin señas: se cobra al entregar (RF44).
CREATE TABLE IF NOT EXISTS pedidos_especiales (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  cliente_nombre   VARCHAR(120) NOT NULL,
  cliente_telefono VARCHAR(40)  NULL,
  fecha_entrega    DATETIME     NOT NULL,
  responsable_id   INT          NULL,
  observaciones    VARCHAR(500) NULL,
  estado           ENUM('pendiente', 'comanda_generada', 'entregado', 'cancelado') NOT NULL DEFAULT 'pendiente',
  pedido_id        INT          NULL,
  mesa_id          INT          NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pe_estado (estado, fecha_entrega)
);
CREATE TABLE IF NOT EXISTS pedido_especial_items (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  especial_id    INT          NOT NULL,
  producto_id    INT          NOT NULL,
  cantidad       INT          NOT NULL,
  observaciones  VARCHAR(255) NULL,
  CONSTRAINT fk_pei_especial FOREIGN KEY (especial_id) REFERENCES pedidos_especiales(id)
);

-- Duración estimada y tolerancia de una reserva (RN40), anticipación del recordatorio (RF43) y con cuánta anticipación un pedido
-- especial genera su comanda al obrador.
INSERT IGNORE INTO parametros (clave, valor) VALUES
  ('reserva_duracion_min', '90'), ('reserva_tolerancia_min', '15'), ('reserva_recordatorio_horas', '24'), ('especial_comanda_anticipo_min', '120');
