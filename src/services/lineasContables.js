// Las líneas de un comprobante con lo que Contable necesita para imputarlas (Contable RF03, RF25): importe efectivamente cobrado (con el descuento de promoción), alícuota de IVA del artículo y
// si es una gift card (que no es venta). Viaja dentro del evento: Contable no consulta las tablas de Ventas.
const redondear2 = (x) => Math.round(Number(x) * 100) / 100;

// `items`: [{ producto_id, importe }] o líneas de la venta con cantidad, precio_unitario e importe_descuento.
const lineasContables = async (conn, items) => {
  const ids = [...new Set(items.map((i) => i.producto_id).filter(Boolean))];
  const [prods] = ids.length ? await conn.query('SELECT id, alicuota_iva, categoria_id, tipo FROM productos WHERE id IN (?)', [ids]) : [[]];
  const por = new Map(prods.map((p) => [p.id, p]));
  return items.map((i) => {
    const p = por.get(i.producto_id);
    const importe = i.importe ?? redondear2(Number(i.cantidad) * Number(i.precio_unitario) - Number(i.importe_descuento ?? 0));
    return { producto_id: i.producto_id, importe: redondear2(importe), alicuota_iva: p ? Number(p.alicuota_iva) : 0, categoria_id: p?.categoria_id ?? null, ...(p?.tipo === 'gift_card' && { gift_card: true }) };
  });
};

module.exports = { lineasContables };
