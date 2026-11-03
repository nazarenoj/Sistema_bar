const pool = require('../config/db');
const Presentacion = require('../models/presentacionModel');
const Equiv = require('../servicios/equivalenciaTerceroService');

// Stock ofrece al diccionario de equivalencias de terceros (Usuarios RF16) el destino "ítem de stock" (un insumo) con una presentación de Stock.
// Stock es el dueño de las unidades y los factores: el diccionario guarda solo el ID de la presentación y, si Stock creó una versión nueva,
// rige la vigente (RN20).
Equiv.registrarDestino('item_stock', {
  existe: async (id) => (await pool.query('SELECT 1 FROM insumos WHERE id = ?', [id]))[0].length > 0,
  presentacion: async (presentacionId, insumoId) => {
    const p = await Presentacion.getById(presentacionId);
    if (!p || p.insumo_id !== insumoId) return null;
    const [[v]] = await pool.query('SELECT id FROM presentaciones WHERE insumo_id = ? AND nombre = ? AND (vigente_hasta IS NULL OR vigente_hasta > NOW()) ORDER BY version DESC LIMIT 1', [p.insumo_id, p.nombre]);
    return { vigente: !!v, vigente_id: v?.id ?? null };
  },
});
