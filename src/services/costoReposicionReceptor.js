const M = require('../mensajeria/servicio');

// Ventas recibe el costo de reposición que publica Compras (Ventas RN81, Compras RN40): copia local, nunca se consulta en línea. Un mensaje viejo no pisa a uno más nuevo.
M.registrarReceptor('ventas', 'costo_reposicion_actualizado', async (conn, c) => {
  await conn.query(
    `INSERT INTO ventas_costos_reposicion (item_tipo, item_id, costo, moneda, fecha) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE costo = VALUES(costo), moneda = VALUES(moneda), fecha = VALUES(fecha)`, [c.item_tipo, c.item_id, c.costo, c.moneda, c.fecha]);
  return { item: `${c.item_tipo}:${c.item_id}` };
});
