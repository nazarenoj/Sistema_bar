-- D6: disponibilidad del menú por franja horaria (Ventas RF29, RN45). Función VEN-FRANJA. Re-ejecutable: tablas IF NOT EXISTS.

-- Una franja de una categoría o de un artículo: días de la semana (0 = domingo) y horario. Un ítem puede tener varias; sin ninguna
-- (propia ni de su categoría) se ofrece siempre.
CREATE TABLE IF NOT EXISTS franjas_menu (
  id           INT         AUTO_INCREMENT PRIMARY KEY,
  nombre       VARCHAR(60) NOT NULL,
  producto_id  INT         NULL,
  categoria_id INT         NULL,
  dias_semana  VARCHAR(20) NULL,
  hora_desde   TIME        NOT NULL,
  hora_hasta   TIME        NOT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_franja_producto (producto_id),
  KEY idx_franja_categoria (categoria_id)
);
