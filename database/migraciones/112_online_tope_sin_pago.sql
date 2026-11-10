-- Ventas Online RN56: porcentaje máximo del disponible que pueden reservar los pedidos sin pago aprobado, y quién autoriza pasarse. Re-ejecutable.
INSERT IGNORE INTO parametros (clave, valor) VALUES ('online_reserva_sin_pago_pct', '30');
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'ventas_online.pedidos.autorizar_reserva' permiso, 'permitido' nivel UNION ALL
  SELECT 'encargado', 'ventas_online.pedidos.autorizar_reserva', 'requiere_autorizacion'
) p ON p.rol = r.codigo;
