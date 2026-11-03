const { Router } = require('express');
const pool = require('../config/db');
const { requierePermiso } = require('../middleware/requierePermiso');
const Monedas = require('../servicios/monedaService');
const Funciones = require('../funciones/servicio');

// Formas de pago configurables (Ventas RF09). No se borran: una forma usada en ventas solo se desactiva.
const router = Router();
const FORMA = 'SELECT * FROM formas_pago WHERE id = ?';

const validar = (b) => {
  if (typeof b.codigo !== 'string' || !/^[a-z0-9_]{2,50}$/.test(b.codigo)) return 'El "codigo" debe tener 2 a 50 caracteres: minúsculas, números o guion bajo.';
  if (b.codigo === 'mixto') return '"mixto" está reservado.';
  if (typeof b.nombre !== 'string' || !b.nombre.trim()) return 'El campo "nombre" es obligatorio.';
  return null;
};
const flag = (v) => (v ? 1 : 0);

// Una forma en divisa se ofrece solo con VEN-DIVISA y una cotización dentro de la antigüedad permitida; si no, queda deshabilitada y se
// ofrece cobrar en pesos (Ventas EX32). El resto de las formas no cambia.
router.get('/', requierePermiso('ventas.cuenta.cobrar'), async (req, res, next) => {
  try {
    const formas = (await pool.query('SELECT * FROM formas_pago ORDER BY orden, id'))[0];
    const conDivisa = await Funciones.estaActiva('VEN-DIVISA');
    const cot = new Map();
    for (const f of formas) {
      f.disponible = true;
      if (f.moneda === 'ARS') continue;
      if (!conDivisa) { f.disponible = false; f.motivo_no_disponible = 'VEN-DIVISA está inactiva.'; continue; }
      if (!cot.has(f.moneda)) cot.set(f.moneda, await Monedas.vigente(f.moneda).catch(() => null));
      const c = cot.get(f.moneda);
      if (!c || c.vencida) { f.disponible = false; f.motivo_no_disponible = `No hay una cotización de ${f.moneda} vigente: cobrá en pesos.`; }
      else f.cotizacion = c.comprador;
    }
    res.json(formas);
  } catch (err) { next(err); }
});

// La moneda de una forma de pago: la local, o una extranjera activa y solo con VEN-DIVISA.
const validarMoneda = async (moneda) => {
  if (moneda === undefined || moneda === 'ARS') return null;
  if (!(await Funciones.estaActiva('VEN-DIVISA'))) return 'Una forma de pago en moneda extranjera necesita la función VEN-DIVISA.';
  const m = await Monedas.obtener(moneda);
  if (!m || !m.activa || m.es_local) return 'La moneda no existe, está desactivada o es la local.';
  return null;
};

router.post('/', requierePermiso('ventas.catalogo.editar'), async (req, res, next) => {
  const error = validar(req.body);
  if (error) return res.status(400).json({ error });
  const b = req.body;
  const errMoneda = await validarMoneda(b.moneda);
  if (errMoneda) return res.status(409).json({ error: errMoneda });
  try {
    const [r] = await pool.query(
      'INSERT INTO formas_pago (codigo, nombre, requiere_referencia, admite_vuelto, orden, moneda) VALUES (?, ?, ?, ?, ?, ?)',
      [b.codigo, b.nombre.trim(), flag(b.requiere_referencia), flag(b.admite_vuelto), Number.isInteger(b.orden) ? b.orden : 0, b.moneda ?? 'ARS']);
    res.status(201).json((await pool.query(FORMA, [r.insertId]))[0][0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe una forma de pago con ese código.' });
    next(err);
  }
});

// El código no cambia (las ventas ya cobradas lo guardan): solo nombre, atributos, orden y si está activa.
router.put('/:id', requierePermiso('ventas.catalogo.editar'), async (req, res, next) => {
  const b = req.body;
  if (typeof b.nombre !== 'string' || !b.nombre.trim()) return res.status(400).json({ error: 'El campo "nombre" es obligatorio.' });
  try {
    const [[actual]] = await pool.query(FORMA, [req.params.id]);
    // La moneda no cambia una vez que la forma tiene cobros: las ventas ya cobradas guardan su moneda y su cotización.
    if (actual && b.moneda !== undefined && b.moneda !== actual.moneda) {
      const [[usada]] = await pool.query('SELECT 1 AS si FROM pago_venta WHERE metodo_pago = ? LIMIT 1', [actual.codigo]);
      if (usada) return res.status(409).json({ error: 'La forma de pago ya tiene cobros: no se le cambia la moneda.' });
      const errMoneda = await validarMoneda(b.moneda);
      if (errMoneda) return res.status(409).json({ error: errMoneda });
    }
    const [r] = await pool.query(
      'UPDATE formas_pago SET nombre = ?, activa = ?, requiere_referencia = ?, admite_vuelto = ?, orden = ?, moneda = ? WHERE id = ?',
      [b.nombre.trim(), b.activa === false || b.activa === 0 ? 0 : 1, flag(b.requiere_referencia), flag(b.admite_vuelto), Number.isInteger(b.orden) ? b.orden : 0, b.moneda ?? actual?.moneda ?? 'ARS', req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Forma de pago no encontrada.' });
    res.json((await pool.query(FORMA, [req.params.id]))[0][0]);
  } catch (err) { next(err); }
});

module.exports = router;
