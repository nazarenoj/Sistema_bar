const M = require('../mensajeria/servicio');

// Stock recibe el costo de reposición como referencia (Compras RF11): sirve de costo provisorio y para valorizar; no es el costo de inventario.
M.registrarReceptor('stock', 'costo_referencia_actualizado', async (conn, c) => {
  await conn.query(
    `INSERT INTO stock_costo_referencia (item_tipo, item_id, costo, moneda, fecha) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE costo = VALUES(costo), moneda = VALUES(moneda), fecha = VALUES(fecha)`, [c.item_tipo, c.item_id, c.costo, c.moneda, c.fecha]);
  return { item: `${c.item_tipo}:${c.item_id}` };
});
