USE sistema_chepola;

-- Momento en que la mesa pasó a ocupada para esta "sesión" de cuenta: todos los pedidos (sillas)
-- que se abren mientras la mesa sigue ocupada sin volver a liberarse comparten el mismo valor.
-- Reemplaza el cálculo de "apertura mesa" que hacía el historial por coincidencia de fecha_cierre,
-- que dejó de ser confiable ahora que las sillas se pueden cerrar de a una en vez de todas juntas.
ALTER TABLE pedidos
  ADD COLUMN sesion_apertura TIMESTAMP NULL DEFAULT NULL AFTER fecha_creacion;

-- Backfill de pedidos ya finalizados: agrupa por mesa + mismo fecha_cierre (misma heurística
-- que usaba el historial hasta ahora, para no perder la apertura de cuentas ya cerradas)
UPDATE pedidos p
JOIN (
  SELECT mesa_id, fecha_cierre, MIN(fecha_creacion) AS apertura
  FROM pedidos
  WHERE fecha_cierre IS NOT NULL
  GROUP BY mesa_id, fecha_cierre
) grp ON grp.mesa_id = p.mesa_id AND grp.fecha_cierre = p.fecha_cierre
SET p.sesion_apertura = grp.apertura
WHERE p.fecha_cierre IS NOT NULL;

-- Backfill de pedidos activos: agrupa por mesa (los activos de una misma mesa comparten sesión)
UPDATE pedidos p
JOIN (
  SELECT mesa_id, MIN(fecha_creacion) AS apertura
  FROM pedidos
  WHERE estado = 'activo'
  GROUP BY mesa_id
) grp ON grp.mesa_id = p.mesa_id
SET p.sesion_apertura = grp.apertura
WHERE p.estado = 'activo';

-- Red de seguridad por si quedó algún caso sin cubrir arriba
UPDATE pedidos SET sesion_apertura = fecha_creacion WHERE sesion_apertura IS NULL;

ALTER TABLE pedidos
  MODIFY COLUMN sesion_apertura TIMESTAMP NOT NULL;
