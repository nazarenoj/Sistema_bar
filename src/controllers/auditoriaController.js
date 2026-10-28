const Auditoria = require('../models/auditoriaModel');
const logger = require('../utils/logger');

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

const listar = async (req, res) => {
  try {
    res.json(await Auditoria.listar(req.query));
  } catch (err) {
    falla500(req, res, err);
  }
};

const verificar = async (req, res) => {
  try {
    res.json(await Auditoria.verificar());
  } catch (err) {
    falla500(req, res, err);
  }
};

const csv = (v) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);

// Exportación con los mismos filtros, hasta 5.000 filas por descarga (usar `antes_de` para seguir).
const exportar = async (req, res) => {
  try {
    const filas = await Auditoria.listar({ ...req.query, limite: 5000, maximo: 5000 });
    const cols = ['id', 'id_global', 'fecha', 'username', 'rol', 'modulo', 'accion', 'resultado', 'entidad', 'entidad_id', 'valor_anterior', 'valor_nuevo', 'detalle', 'ip'];
    const lineas = filas.map((f) => cols.map((c) => csv(c === 'fecha' ? new Date(Number(f.ts_ms)).toISOString() : f[c])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auditoria.csv"');
    res.send('﻿' + [cols.join(','), ...lineas].join('\r\n'));
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = { listar, verificar, exportar };
