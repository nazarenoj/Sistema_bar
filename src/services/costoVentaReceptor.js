const M = require('../mensajeria/servicio');

// Ventas como receptor de la confirmación del descuento de Stock (Ventas RN62, RN75, EX47): guarda por línea el costo
// con que salió (Costo_Aplicado), su origen y si es provisorio. Queda congelado: Ventas no lo recalcula (RN62) ni toca la
// venta ni su comprobante (RN19).
M.registrarReceptor('ventas', 'costo_confirmado', async (conn, c, ctx) => {
  for (const l of c.lineas)
    await conn.query(
      'INSERT IGNORE INTO lineas_costo (doc_tipo, doc_id_global, linea, costo_unitario, origen_costo, provisorio, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [c.doc_tipo ?? 'venta', ctx.docIdGlobal, l.linea, l.costo_unitario, l.origen_costo, l.provisorio ? 1 : 0, JSON.stringify(l.detalle ?? [])]);
  return { lineas: c.lineas.length };
});
