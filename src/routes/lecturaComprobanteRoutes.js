const express = require('express');
const Lectura = require('../servicios/lecturaComprobanteService');
const Equiv = require('../servicios/equivalenciaTerceroService');
const requiereFuncion = require('../middleware/requiereFuncion');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Lectura de comprobantes por foto (Usuarios RF15) y diccionario de equivalencias de terceros (RF16). La lectura solo propone (RN18).
const lectura = express.Router();
const manejarL = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Lectura.LecturaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};
const archivo = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: '12mb' });

lectura.get('/configuracion', requierePermiso('usuarios.gestionar'), manejarL(async (req, res) => res.json(await Lectura.config())));
lectura.put('/configuracion', requierePermiso('usuarios.gestionar'), manejarL(async (req, res) => {
  const c = await Lectura.configurar(req.body);
  await auditar(req, { modulo: 'lectura', accion: 'configurar', entidad: 'servicio', entidad_id: '1', detalle: c.url ?? 'sin servicio' });
  res.json(c);
}));
// La imagen o el PDF viajan tal cual en el cuerpo. Devuelve una propuesta, o "pendiente" si el servicio no responde (EX11).
lectura.post('/leer', requiereFuncion('USU-FOTO'), archivo, manejarL(async (req, res) => res.json(await Lectura.leer({ imagen: req.body, tipo: String(req.get('content-type') ?? '').split(';')[0] }))));
lectura.post('/qr', requiereFuncion('USU-FOTO'), manejarL(async (req, res) => res.json(await Lectura.leerQr(req.body.texto))));

const equivalencias = express.Router();
const manejarE = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Equiv.EquivalenciaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};
const GESTIONAR = requierePermiso('usuarios.equivalencias.gestionar');
equivalencias.get('/', GESTIONAR, manejarE(async (req, res) => res.json(await Equiv.listar(req.query))));
equivalencias.post('/', GESTIONAR, manejarE(async (req, res) => {
  const e = await Equiv.guardar(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'equivalencias', accion: 'guardar', entidad: 'equivalencia', entidad_id: String(e.id), detalle: `${e.cuit_emisor} ${e.descripcion}` });
  res.status(201).json(e);
}));
equivalencias.post('/resolver', manejarE(async (req, res) => {
  const e = await Equiv.resolver(req.body);
  return e ? res.json(e) : res.status(404).json({ error: 'No hay equivalencia para ese texto de ese emisor.' });
}));
equivalencias.post('/revisar', GESTIONAR, manejarE(async (req, res) => res.json(await Equiv.revisar())));
equivalencias.delete('/:id', GESTIONAR, manejarE(async (req, res) => { await Equiv.borrar(Number(req.params.id)); res.json({ borrada: true }); }));

module.exports = { lectura, equivalencias };
