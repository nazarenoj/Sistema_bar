USE sistema_chepola;

-- El historial (WHERE estado = 'finalizado' ORDER BY fecha_cierre) y el subquery de "hora de
-- cierre de mesa" (mesa_id + sesion_apertura) sólo tenían el índice de la FK en mesa_id. Sin
-- estos índices, ambas consultas escanean toda la tabla a medida que crece el historial.
ALTER TABLE pedidos
  ADD INDEX idx_pedidos_historial (estado, fecha_cierre),
  ADD INDEX idx_pedidos_sesion (mesa_id, sesion_apertura);
