const M = require('../mensajeria/servicio');

// Ventas como receptor de la disponibilidad que informa Stock (Stock RF32): pone o quita la marca automática de agotado, que se
// muestra en cocina/barra y no impide agregar el artículo a un pedido (Ventas RN01). Idempotente: fija el estado, no lo alterna.
M.registrarReceptor('ventas', 'disponibilidad_item', async (conn, c) => {
  await conn.query('UPDATE productos SET agotado_auto = ? WHERE id = ?', [c.agotado ? 1 : 0, c.producto_id]);
  return { producto_id: c.producto_id, agotado: !!c.agotado };
}, {});
