const { Router } = require('express');
const pool = require('../config/db');
const Mov = require('../stock/movimientoService');
const { requierePermiso, validarAutorizacion } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO } = require('../services/reporteService');

// Movimientos, kardex y consultas de Stock (RF04, RF12, RF13, RF18, RN02). El stock solo cambia por acá.
const router = Router();
const VER = requierePermiso('stock.movimientos.ver');
const REGISTRAR = requierePermiso('stock.movimientos.registrar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Mov.MovimientoInvalido) return res.status(err.status || 400).json({ error: err.message, codigo: 'MOVIMIENTO_INVALIDO' });
    next(err);
  }
};
const usuario = (req) => req.usuario?.sub ?? null;

// ---- Consultas ----

router.get('/existencias', VER, manejar(async (req, res) => {
  const filas = await Mov.existencias({ deposito_id: req.query.deposito_id, tipo: req.query.tipo });
  res.json(filas);
}));

// ?item_tipo=insumo|producto&item_id=N[&deposito_id][&desde][&hasta][&formato=csv|xlsx|pdf|json]
router.get('/kardex', VER, manejar(async (req, res) => {
  const item = { tipo: req.query.item_tipo, id: Number(req.query.item_id) };
  const filas = await Mov.kardex({ item, deposito_id: req.query.deposito_id, desde: req.query.desde, hasta: req.query.hasta });
  if (!req.query.formato) return res.json(filas);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await enviarReporte(res, {
    titulo: 'Kardex', subtitulo: `${item.tipo} ${item.id}`, filtros: [], resumen: [{ label: 'Movimientos', valor: filas.length, tipo: 'numero' }],
    hojas: [{ nombre: 'Kardex', columnas: [
      { key: 'fecha', label: 'Fecha', tipo: 'fecha', ancho: 17 }, { key: 'tipo', label: 'Tipo', tipo: 'texto', ancho: 14 }, { key: 'motivo', label: 'Motivo', tipo: 'texto', ancho: 18 },
      { key: 'deposito', label: 'Depósito', tipo: 'texto', ancho: 18 }, { key: 'cantidad', label: 'Cantidad', tipo: 'numero', ancho: 11 }, { key: 'saldo', label: 'Saldo', tipo: 'numero', ancho: 11 },
    ], filas: filas.map((f) => ({ fecha: f.created_at, tipo: f.tipo, motivo: f.motivo, deposito: f.deposito, cantidad: f.cantidad, saldo: f.saldo })) }],
  }, req.query.formato, `kardex-${item.tipo}-${item.id}`);
}));

router.get('/mermas', VER, manejar(async (req, res) => res.json(await Mov.mermas(req.query))));

// ---- Movimientos ----

router.post('/ingresos', REGISTRAR, manejar(async (req, res) => {
  const r = await Mov.ingresar(req.body, { userId: usuario(req) });
  await auditar(req, { modulo: 'stock', accion: 'ingreso', entidad: 'ingreso', entidad_id: r.id_global, detalle: `${r.movimientos.length} línea(s), motivo ${r.motivo}` });
  res.status(201).json(r);
}));

// El motivo define si exige la autorización de un supervisor (RF12).
router.post('/egresos', REGISTRAR, manejar(async (req, res) => {
  const m = await Mov.motivoDeEgreso(req.body.motivo);
  let autorizo = null;
  if (m.requiere_autorizacion) {
    const a = await validarAutorizacion(req, 'stock.movimientos.registrar');
    if (!a.ok) return res.status(a.status).json({ error: `El motivo "${m.nombre}" necesita la autorización de un supervisor.`, codigo: a.codigo });
    autorizo = a.supervisor.username;
  }
  const r = await Mov.egresar(req.body, { userId: usuario(req) });
  await auditar(req, { modulo: 'stock', accion: 'egreso', entidad: 'egreso', entidad_id: r.documento, detalle: `motivo ${r.motivo}${autorizo ? `, autorizó ${autorizo}` : ''}` });
  res.status(201).json(r);
}));

router.post('/transferencias', REGISTRAR, manejar(async (req, res) => {
  const r = await Mov.transferir(req.body, { userId: usuario(req) });
  await auditar(req, { modulo: 'stock', accion: 'transferencia', entidad: 'transferencia', entidad_id: r.documento, detalle: `${r.origen_id} -> ${r.destino_id}` });
  res.status(201).json(r);
}));

router.post('/movimientos/:id/corregir', REGISTRAR, manejar(async (req, res) => {
  const r = await Mov.corregir(Number(req.params.id), req.body.observacion, { userId: usuario(req) });
  await auditar(req, { modulo: 'stock', accion: 'correccion', entidad: 'movimiento', entidad_id: String(req.params.id), detalle: req.body.observacion });
  res.status(201).json(r);
}));

// ---- Motivos de ingreso y de egreso (RF12) ----

router.get('/motivos', VER, manejar(async (req, res) => res.json((await pool.query('SELECT * FROM motivos_stock ORDER BY tipo, reservado DESC, nombre'))[0])));

const CLASES = ['merma', 'sin_asiento', 'otra'];
router.post('/motivos', REGISTRAR, manejar(async (req, res) => {
  const b = req.body;
  if (!/^[a-z0-9_]{2,50}$/.test(b.codigo ?? '') || typeof b.nombre !== 'string' || !b.nombre.trim()) return res.status(400).json({ error: 'Indicá "codigo" (minúsculas, números y guion bajo) y "nombre".' });
  if (!['ingreso', 'egreso'].includes(b.tipo)) return res.status(400).json({ error: '"tipo" debe ser ingreso o egreso.' });
  if (b.clase_contable !== undefined && !CLASES.includes(b.clase_contable)) return res.status(400).json({ error: `"clase_contable" debe ser una de: ${CLASES.join(', ')}.` });
  try {
    const [r] = await pool.query('INSERT INTO motivos_stock (codigo, nombre, tipo, requiere_autorizacion, requiere_observacion, clase_contable) VALUES (?, ?, ?, ?, ?, ?)',
      [b.codigo, b.nombre.trim(), b.tipo, b.requiere_autorizacion ? 1 : 0, b.requiere_observacion ? 1 : 0, b.clase_contable ?? 'otra']);
    res.status(201).json((await pool.query('SELECT * FROM motivos_stock WHERE id = ?', [r.insertId]))[0][0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un motivo con ese código.' });
    throw err;
  }
}));

// Un motivo reservado del sistema no se desactiva y conserva su clase contable (RF12).
router.put('/motivos/:id', REGISTRAR, manejar(async (req, res) => {
  const [[m]] = await pool.query('SELECT * FROM motivos_stock WHERE id = ?', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'Motivo no encontrado.' });
  const b = req.body;
  if (m.reservado && (b.activo === false || (b.clase_contable !== undefined && b.clase_contable !== m.clase_contable)))
    return res.status(409).json({ error: 'Es un motivo reservado del sistema: no se desactiva ni cambia de clase contable.' });
  if (b.clase_contable !== undefined && !CLASES.includes(b.clase_contable)) return res.status(400).json({ error: `"clase_contable" debe ser una de: ${CLASES.join(', ')}.` });
  await pool.query('UPDATE motivos_stock SET nombre = ?, requiere_autorizacion = ?, requiere_observacion = ?, clase_contable = ?, activo = ? WHERE id = ?',
    [b.nombre?.trim() || m.nombre, (b.requiere_autorizacion ?? m.requiere_autorizacion) ? 1 : 0, (b.requiere_observacion ?? m.requiere_observacion) ? 1 : 0, b.clase_contable ?? m.clase_contable, b.activo === false ? 0 : 1, m.id]);
  res.json((await pool.query('SELECT * FROM motivos_stock WHERE id = ?', [m.id]))[0][0]);
}));

module.exports = router;
