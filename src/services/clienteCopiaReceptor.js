const M = require('../mensajeria/servicio');

// Ventas guarda en una copia local lo que necesita de los clientes y no los consulta en línea (Clientes RN42, RN43; Ventas RN81):
// el mapa de alias de las fichas unificadas y la lista de precios y condición de socio de cada cliente.
M.registrarReceptor('ventas', 'clientes_unificados', async (conn, c) => {
  await conn.query('INSERT INTO ventas_cliente_alias (alias_id, resultante_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE resultante_id = VALUES(resultante_id)', [c.absorbido_id, c.resultante_id]);
  await conn.query('UPDATE ventas_cliente_alias SET resultante_id = ? WHERE resultante_id = ?', [c.resultante_id, c.absorbido_id]); // una cadena se resuelve a la ficha final
  return { alias: c.absorbido_id };
});

M.registrarReceptor('ventas', 'cliente_actualizado', async (conn, c) => {
  await conn.query(
    `INSERT INTO ventas_clientes_copia (cliente_id, razon_social, lista_precio_id, socio, actualizado_ms) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE razon_social = IF(VALUES(actualizado_ms) >= actualizado_ms, VALUES(razon_social), razon_social), lista_precio_id = IF(VALUES(actualizado_ms) >= actualizado_ms, VALUES(lista_precio_id), lista_precio_id),
       socio = IF(VALUES(actualizado_ms) >= actualizado_ms, VALUES(socio), socio), actualizado_ms = GREATEST(actualizado_ms, VALUES(actualizado_ms))`, // un mensaje viejo que llega tarde no pisa uno nuevo
    [c.cliente_id, c.razon_social, c.lista_precio_id ?? null, c.socio ? 1 : 0, Number(c.version_ms ?? Date.now())]);
  return { cliente: c.cliente_id };
});
