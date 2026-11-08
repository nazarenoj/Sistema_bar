-- J5: Contable, libros (diario, mayor, sumas y saldos): exportar es una acción con permiso (Contable RN13). Re-ejecutable.
INSERT IGNORE INTO rol_permisos (rol_id, permiso, nivel)
SELECT r.id, p.permiso, p.nivel FROM roles r JOIN (
  SELECT 'gerente' rol, 'contable.exportar' permiso, 'permitido' nivel UNION ALL
  SELECT 'contador', 'contable.exportar', 'permitido'
) p ON p.rol = r.codigo;
