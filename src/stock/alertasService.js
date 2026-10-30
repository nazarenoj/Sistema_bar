const pool = require('../config/db');
const Notificacion = require('../models/notificacionModel');

// Alertas de Stock por el Centro de Notificaciones (Stock RF16). Cada alerta tiene una clave: existe una sola vez mientras
// siga abierta y se resuelve sola cuando la situación se corrige.
const ROLES = ['administrador', 'encargado', 'deposito'];

// Un ítem llega al punto de reposición o queda por debajo del mínimo, en un depósito; y un ítem con saldo negativo (el
// descuento de una venta ya cerrada lo dejó así, EX01). Devuelve cuántas alertas quedaron abiertas.
const evaluar = async () => {
  let abiertas = 0;
  const [filas] = await pool.query(
    `SELECT c.insumo_id, i.nombre, c.deposito_id, d.nombre AS deposito, c.stock_minimo, c.punto_reposicion, COALESCE(SUM(m.cantidad), 0) AS fisico
     FROM item_deposito_config c JOIN insumos i ON i.id = c.insumo_id JOIN depositos d ON d.id = c.deposito_id
     LEFT JOIN stock_movimientos m ON m.insumo_id = c.insumo_id AND m.deposito_id = c.deposito_id
     GROUP BY c.insumo_id, i.nombre, c.deposito_id, d.nombre, c.stock_minimo, c.punto_reposicion`);
  for (const f of filas) {
    const fisico = Number(f.fisico);
    const bajoMinimo = Number(f.stock_minimo) > 0 && fisico < Number(f.stock_minimo);
    const enReposicion = Number(f.punto_reposicion) > 0 && fisico <= Number(f.punto_reposicion);
    // Dos alertas que escalan: al bajar del mínimo se cierra la de reposición y queda la del mínimo.
    const claveRep = `stock-bajo:insumo:${f.insumo_id}:${f.deposito_id}`;
    const claveMin = `stock-minimo:insumo:${f.insumo_id}:${f.deposito_id}`;
    if (bajoMinimo) {
      abiertas++;
      await Notificacion.resolverPorClave(claveRep, 'Bajó del mínimo: rige la alerta de stock mínimo');
      await Notificacion.crear({ modulo: 'stock', tipo: 'stock_bajo_minimo', severidad: 'alta', roles: ROLES, clave: claveMin,
        mensaje: `${f.nombre} en ${f.deposito}: ${fisico} (por debajo del mínimo de ${Number(f.stock_minimo)}).` });
    } else {
      await Notificacion.resolverPorClave(claveMin, 'El saldo volvió por encima del mínimo');
      if (enReposicion) {
        abiertas++;
        await Notificacion.crear({ modulo: 'stock', tipo: 'punto_reposicion', severidad: 'media', roles: ROLES, clave: claveRep,
          mensaje: `${f.nombre} en ${f.deposito}: ${fisico} (llegó al punto de reposición de ${Number(f.punto_reposicion)}).` });
      } else await Notificacion.resolverPorClave(claveRep, 'El saldo volvió a un nivel normal');
    }
  }

  for (const [tipo, tabla] of [['insumo', 'insumos'], ['producto', 'productos']]) {
    const [items] = await pool.query(`SELECT id, nombre, stock FROM ${tabla} WHERE controla_stock = 1`);
    for (const it of items) {
      const clave = `stock-negativo:${tipo}:${it.id}`;
      if (Number(it.stock) < 0) {
        abiertas++;
        await Notificacion.crear({ modulo: 'stock', tipo: 'stock_negativo', severidad: 'alta', roles: ROLES, clave, mensaje: `${it.nombre} quedó con saldo negativo (${Number(it.stock)}): revisá el descuento o ajustalo.` });
      } else await Notificacion.resolverPorClave(clave, 'El saldo ya no es negativo');
    }
  }
  return abiertas;
};

// Reposición sugerida por depósito (RF16): lo que falta para llegar al punto de reposición, sobre el disponible (físico menos
// comprometido). El cálculo por consumo promedio es de la reposición automática (RF29).
const reposicionSugerida = async ({ deposito_id } = {}) => {
  const Compromiso = require('./compromisoService');
  const tomados = await Compromiso.comprometidos();
  const [filas] = await pool.query(
    `SELECT c.insumo_id, i.nombre, i.unidad, c.deposito_id, d.nombre AS deposito, c.stock_minimo, c.punto_reposicion, COALESCE(SUM(m.cantidad), 0) AS fisico
     FROM item_deposito_config c JOIN insumos i ON i.id = c.insumo_id JOIN depositos d ON d.id = c.deposito_id
     LEFT JOIN stock_movimientos m ON m.insumo_id = c.insumo_id AND m.deposito_id = c.deposito_id
     ${deposito_id ? 'WHERE c.deposito_id = ?' : ''}
     GROUP BY c.insumo_id, i.nombre, i.unidad, c.deposito_id, d.nombre, c.stock_minimo, c.punto_reposicion ORDER BY d.nombre, i.nombre`, deposito_id ? [deposito_id] : []);
  return filas.map((f) => {
    const fisico = Number(f.fisico);
    const disponible = fisico - (tomados.get(Compromiso.recursoDe('insumo', f.insumo_id, f.deposito_id)) ?? 0);
    return { insumo_id: f.insumo_id, nombre: f.nombre, unidad: f.unidad, deposito_id: f.deposito_id, deposito: f.deposito, fisico, disponible, stock_minimo: Number(f.stock_minimo),
      punto_reposicion: Number(f.punto_reposicion), sugerida: Math.max(0, Math.round((Number(f.punto_reposicion) - disponible) * 1000) / 1000) };
  }).filter((f) => f.punto_reposicion > 0 && f.disponible <= f.punto_reposicion);
};

module.exports = { evaluar, reposicionSugerida };
