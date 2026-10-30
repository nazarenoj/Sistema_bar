const Receta = require('./recetaService');
const Funciones = require('../funciones/servicio');

// Qué descuenta una línea vendida (Stock RF30, RF31, RF38): la explosión de la receta (RF09) más lo que cambian las opciones de modificador y el envase de la modalidad del pedido. Devuelve Map 'insumo:ID' | 'producto:ID' -> cantidad.
const hojasDeLinea = async (conn, { producto_id, cantidad, opciones = [], modalidad = null }) => {
  const m = await Receta.hojas(conn, producto_id, cantidad);
  const suma = (k, q) => { const v = (m.get(k) ?? 0) + q; if (v > 0.0000001) m.set(k, v); else m.delete(k); };

  // Modificadores (VEN-MODIF): sustituir quita lo del original y suma el sustituto; si el original no está en la receta no se toca nada.
  if (opciones.length && (await Funciones.estaActiva('VEN-MODIF', conn))) {
    const [filas] = await conn.query('SELECT * FROM modificador_insumos WHERE opcion_id IN (?) ORDER BY id', [opciones.map(String)]);
    for (const f of filas) {
      const orig = f.insumo_original_id ? `insumo:${f.insumo_original_id}` : null;
      if (f.accion !== 'agregar' && !m.has(orig)) continue;
      if (orig) suma(orig, -Math.min(m.get(orig), Number(f.cantidad_original) * cantidad));
      if (f.accion !== 'quitar') suma(`insumo:${f.insumo_id}`, Number(f.cantidad) * cantidad);
    }
  }

  // Envase de la modalidad: el mapeo del artículo prevalece sobre el de su categoría; sin mapeo no se descuenta nada.
  if (modalidad) {
    const [[p]] = await conn.query('SELECT categoria_id FROM productos WHERE id = ?', [producto_id]);
    const [[e]] = await conn.query("SELECT insumo_id, cantidad FROM envases_modalidad WHERE modalidad = ? AND alcance IN (?, ?) ORDER BY alcance LIKE 'p:%' DESC LIMIT 1",
      [modalidad, `p:${producto_id}`, `c:${p?.categoria_id ?? 0}`]);
    if (e) suma(`insumo:${e.insumo_id}`, Number(e.cantidad) * cantidad);
  }
  return m;
};

module.exports = { hojasDeLinea };
