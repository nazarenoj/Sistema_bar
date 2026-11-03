const pool = require('../config/db');
const Equiv = require('../servicios/equivalenciaTerceroService');

// Ventas ofrece al diccionario de equivalencias de terceros (Usuarios RF16) el destino "artículo": un producto de la carta.
Equiv.registrarDestino('articulo', { existe: async (id) => (await pool.query('SELECT 1 FROM productos WHERE id = ?', [id]))[0].length > 0 });
