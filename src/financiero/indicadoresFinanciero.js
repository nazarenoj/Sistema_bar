const pool = require('../config/db');
const Tablero = require('../servicios/tableroService');
const Consolidacion = require('../servicios/consolidacionService');
const Proyeccion = require('./proyeccionService');
const { r2 } = require('./comun');

// Indicadores de Financiero para el tablero (RF25): saldo de cajas y cuentas, flujo proyectado a 7 y 30 días, diferencias de caja del día y acreditaciones pendientes. Se calculan con
// los datos de la instancia, sin servicios externos, y se muestran solo a quien tiene permiso sobre los saldos.
const hoyMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

Tablero.registrar([
  { id: 'financiero.saldos', nombre: 'Saldo de cajas y cuentas', modulo: 'financiero', permiso: 'financiero.saldos.ver', unidad: '$', calcular: async () => ({ valor: await Proyeccion.saldoActual() }) },
  { id: 'financiero.flujo7', nombre: 'Flujo de fondos proyectado a 7 días', modulo: 'financiero', permiso: 'financiero.saldos.ver', unidad: '$', calcular: async () => ({ valor: await Proyeccion.saldoProyectado(7) }) },
  { id: 'financiero.flujo30', nombre: 'Flujo de fondos proyectado a 30 días', modulo: 'financiero', permiso: 'financiero.saldos.ver', unidad: '$', calcular: async () => ({ valor: await Proyeccion.saldoProyectado(30) }) },
  { id: 'financiero.diferencias', nombre: 'Diferencias de caja del día', modulo: 'financiero', permiso: 'financiero.saldos.ver', unidad: '$',
    calcular: async () => {
      const [[r]] = await pool.query('SELECT COALESCE(SUM(c.diferencia), 0) AS neto, COALESCE(SUM(ABS(c.diferencia)), 0) AS absoluto, COUNT(*) AS cierres FROM fin_cierres c WHERE c.cerrado_ms >= ?', [hoyMs()]);
      return { valor: r2(r.neto), detalle: { diferencia_absoluta: r2(r.absoluto), cierres: Number(r.cierres) } };
    } },
  { id: 'financiero.acreditaciones', nombre: 'Acreditaciones pendientes', modulo: 'financiero', permiso: 'financiero.saldos.ver', unidad: '$',
    calcular: async () => {
      const [[r]] = await pool.query("SELECT COALESCE(SUM(bruto), 0) AS total, COUNT(*) AS cantidad FROM fin_acreditaciones WHERE estado = 'pendiente'");
      return { valor: r2(r.total), detalle: { cantidad: Number(r.cantidad) } };
    } },
]);

// Paquete de consolidación para la Casa Central (RF26): solo lectura, idempotente (lo identifican sucursal, período y versión), con movimientos agregados por día, caja o cuenta, tipo,
// categoría y moneda, los saldos de cierre de cada caja y cuenta y las diferencias de caja de los turnos. Sin detalle de cheques, cuentas ni movimientos individuales.
Consolidacion.registrarPaquete('financiero', {
  funcion: 'USU-CONSOL',
  generar: async (periodo) => {
    const desde = new Date(`${periodo}T00:00:00`).getTime(), hasta = new Date(`${periodo}T23:59:59.999`).getTime();
    const [mov] = await pool.query(
      `SELECT c.nombre AS cuenta, m.tipo, COALESCE(k.nombre, '') AS categoria, m.moneda, SUM(m.importe) AS importe, COUNT(*) AS cantidad FROM fin_movimientos m JOIN fin_cuentas c ON c.id = m.cuenta_id
       LEFT JOIN fin_categorias k ON k.id = m.categoria_id WHERE m.fecha_ms BETWEEN ? AND ? GROUP BY c.nombre, m.tipo, k.nombre, m.moneda ORDER BY c.nombre, m.tipo`, [desde, hasta]);
    const [saldos] = await pool.query(
      `SELECT c.nombre AS cuenta, c.moneda, c.saldo_inicial + COALESCE((SELECT SUM(m.importe) FROM fin_movimientos m WHERE m.cuenta_id = c.id AND m.fecha_ms <= ?), 0) AS saldo FROM fin_cuentas c WHERE c.activa = 1 ORDER BY c.nombre`, [hasta]);
    const [dif] = await pool.query('SELECT t.id AS turno, ca.nombre AS caja, c.diferencia FROM fin_cierres c JOIN fin_turnos t ON t.id = c.turno_id JOIN fin_cuentas ca ON ca.id = t.cuenta_id WHERE c.cerrado_ms BETWEEN ? AND ? ORDER BY t.id', [desde, hasta]);
    return {
      movimientos: mov.map((m) => ({ cuenta: m.cuenta, tipo: m.tipo, categoria: m.categoria, moneda: m.moneda, importe: r2(m.importe), cantidad: Number(m.cantidad) })),
      saldos_cierre: saldos.map((s) => ({ cuenta: s.cuenta, moneda: s.moneda, saldo: r2(s.saldo) })),
      diferencias_de_caja: dif.map((d) => ({ turno: d.turno, caja: d.caja, diferencia: r2(d.diferencia) })),
    };
  },
});
