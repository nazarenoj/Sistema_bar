const M = require('../mensajeria/servicio');

// Stock recibe los pedidos de Compras que están en tránsito (Compras RF12): lo pedido y todavía no recibido se descuenta de la reposición sugerida. Cada mensaje trae el estado completo del pedido.
M.registrarReceptor('stock', 'pedido_en_transito', async (conn, c) => {
  await conn.query('DELETE FROM stock_pedidos_transito WHERE pedido_id_global = ?', [c.pedido_id_global]);
  for (const l of c.abierto ? c.lineas : [])
    await conn.query('INSERT INTO stock_pedidos_transito (pedido_id_global, item_tipo, item_id, cantidad) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)', [c.pedido_id_global, l.item_tipo, l.item_id, l.cantidad]);
  return { lineas: c.abierto ? c.lineas.length : 0 };
});
