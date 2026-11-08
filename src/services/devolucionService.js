const SerieVenta = require('./serieVentaService');
const pool = require('../config/db');
const afipConfig = require('../config/afipConfig');
const Mensajeria = require('../mensajeria/servicio');
const Parametro = require('../models/parametroModel');
const Factura = require('../models/facturaModel');
const puertos = require('../modulos/puertos');
const llamar = require('../modulos/llamar');
const Funciones = require('../funciones/servicio');
const afipService = require('./afipService');
const Venta = require('./ventaService');
const { idGlobal } = require('../utils/idGlobal');

// Anulación y devolución de ventas (Ventas RF15, RF49, RN19, RN76). Cada devolución es un documento propio:
// la venta original no se modifica. Anular es devolver todo lo que quede. Si la venta tenía factura aprobada
// se emite la nota de crédito por el servicio de emisión; si ARCA falla la devolución no se revierte y la
// nota queda pendiente de reintento (/api/facturas/:id/reintentar).
class DevolucionInvalida extends Error {}

const NC_DE = { 1: 3, 6: 8, 11: 13 }; // Factura A/B/C -> Nota de Crédito A/B/C
const centavos = (n) => Math.round(Number(n) * 100);

// Reparto por defecto del reintento: proporcional a lo pagado con cada forma, con el redondeo en la última (RN76).
const repartoOriginal = (pagos, totalVenta, total) => {
  const salida = [];
  let asignado = 0;
  pagos.forEach((p, i) => {
    const importe = i === pagos.length - 1 ? (centavos(total) - asignado) / 100 : Math.round(centavos(total) * Number(p.importe) / Number(totalVenta)) / 100;
    asignado += centavos(importe);
    salida.push({ forma: p.metodo_pago, importe });
  });
  return salida;
};

// ¿Devolver con una forma de pago distinta de las originales? Pide supervisor mientras el parámetro lo exija (RN76.3).
const necesitaAutorizacion = async (venta, reintegro) => {
  if (!Array.isArray(reintegro) || !reintegro.length) return false;
  if (!((await Parametro.todos()).reintegro_otra_forma_requiere_supervisor ?? 1)) return false;
  const originales = new Set(venta.pagos.map((p) => p.metodo_pago));
  return reintegro.some((r) => !originales.has(r.forma));
};

const yaDevuelto = async (conn, ventaId) => {
  const [rows] = await conn.query(
    'SELECT di.linea, SUM(di.cantidad) AS cantidad FROM devolucion_items di JOIN devoluciones d ON d.id = di.devolucion_id WHERE d.venta_id = ? GROUP BY di.linea', [ventaId]);
  return new Map(rows.map((r) => [r.linea, Number(r.cantidad)]));
};

// items: [{ linea, cantidad }] o `todo: true` para anular lo que quede.
const devolver = async (idGlobalVenta, { items, todo, motivo, reingreso = 'reingreso', reintegro, series = [], cliente_id: clienteVale = null }, { idSolicitud, userId, autorizadoPor, terminalId = null, autorizar = null } = {}) => {
  if (typeof motivo !== 'string' || !motivo.trim()) throw new DevolucionInvalida('El motivo es obligatorio.');
  if (!['reingreso', 'merma'].includes(reingreso)) throw new DevolucionInvalida('"reingreso" debe ser reingreso o merma.');
  const venta = await Venta.obtener(idGlobalVenta);
  if (!venta) throw Object.assign(new DevolucionInvalida('Venta no encontrada.'), { status: 404 });

  const conn = await pool.getConnection();
  let devolucion, itemsDev, reintegros, nc;
  const advertencias = [];
  try {
    await conn.beginTransaction();
    // Se serializa sobre la venta: dos devoluciones simultáneas no pueden devolver dos veces lo mismo.
    await conn.query('SELECT id FROM ventas WHERE id = ? FOR UPDATE', [venta.id]);
    const devuelto = await yaDevuelto(conn, venta.id);

    const pedidas = todo
      ? venta.detalle.map((l, linea) => ({ linea, cantidad: l.cantidad - (devuelto.get(linea) ?? 0) })).filter((i) => i.cantidad > 0)
      : items;
    if (!Array.isArray(pedidas) || !pedidas.length) throw new DevolucionInvalida(todo ? 'No queda nada por devolver en esta venta.' : 'Indicá los ítems a devolver.');

    itemsDev = pedidas.map(({ linea, cantidad }) => {
      const l = venta.detalle[linea];
      if (!l || !Number.isInteger(cantidad) || cantidad <= 0) throw new DevolucionInvalida('Ítem de devolución inválido.');
      if (cantidad > l.cantidad - (devuelto.get(linea) ?? 0)) throw new DevolucionInvalida(`No se puede devolver más de lo vendido y no devuelto de "${l.nombre}".`);
      // Lo devuelto es el precio efectivamente cobrado: el importe de la línea menos su descuento de promoción, en proporción (RN34).
      const importe = Math.round((cantidad * l.precio_unitario - (l.importe_descuento ?? 0) * cantidad / l.cantidad) * 100) / 100;
      const base = { linea, producto_id: l.producto_id, nombre: l.nombre, cantidad, precio_unitario: Math.round(importe / cantidad * 100) / 100, importe };
      if (!l.serie) return base;
      // Un artículo con número de serie: Ventas pide indicar si tiene falla y, con falla, el motivo (Ventas RN79).
      const dato = (Array.isArray(series) ? series : []).find((s) => s.linea === linea);
      if (typeof dato?.falla !== 'boolean') throw new DevolucionInvalida(`Indicá si la serie ${l.serie} de "${l.nombre}" tiene falla (series: [{ linea, falla, motivo }]).`);
      if (dato.falla && !String(dato.motivo ?? '').trim()) throw new DevolucionInvalida(`La serie ${l.serie} vuelve con falla: indicá el motivo de la baja.`);
      return { ...base, serie: l.serie, condicion: dato.falla ? 'con_falla' : 'sin_falla', motivo_falla: dato.falla ? String(dato.motivo).trim() : null };
    });
    if (new Set(itemsDev.map((i) => i.linea)).size !== itemsDev.length) throw new DevolucionInvalida('Hay líneas repetidas.');
    const total = itemsDev.reduce((a, i) => a + centavos(i.importe), 0) / 100;

    // Reintegro: el reparto original salvo que el usuario elija otro (RF49).
    reintegros = reintegro?.length ? reintegro : repartoOriginal(venta.pagos, venta.total, total);
    const [formas] = await conn.query("SELECT codigo FROM formas_pago WHERE activa = 1 OR codigo IN ('cobro_online', 'cobro_plataforma')");
    const activas = new Set(formas.map((f) => f.codigo));
    for (const r of reintegros) {
      if (!activas.has(r.forma)) throw new DevolucionInvalida(`La forma de reintegro "${r.forma}" no existe o está desactivada.`);
      if (!(Number(r.importe) > 0)) throw new DevolucionInvalida('Cada importe de reintegro debe ser mayor a cero.');
    }
    if (reintegros.reduce((a, r) => a + centavos(r.importe), 0) !== centavos(total))
      throw new DevolucionInvalida(`El reintegro (${reintegros.reduce((a, r) => a + Number(r.importe), 0)}) debe sumar lo devuelto (${total}).`);

    // Antes de entregar efectivo se consulta el saldo de la caja (llamada n.º 20, Financiero RN45). Si no alcanza, o Financiero no responde, el efectivo solo sale con la autorización
    // de un supervisor en ese momento y la devolución queda marcada «saldo negativo autorizado» o «saldo no verificado» (Ventas EX58, Financiero RN42).
    let saldoAutorizadoPor = null, saldoNoVerificado = false;
    const enEfectivo = reintegros.filter((r) => r.forma === 'efectivo').reduce((a, r) => a + centavos(r.importe), 0) / 100;
    if (enEfectivo > 0) {
      const c = await llamar(20, 'ventas', async () => (await puertos.obtener('cobros')).saldoCaja({ terminalId }));
      if (!(c.fallo && c.degradado && /no instalado/.test(c.motivo ?? ''))) { // sin Financiero no hay caja que consultar
        const noResponde = !!c.fallo;
        const saldo = c.valor?.saldo;
        if (noResponde || (saldo !== null && saldo !== undefined && saldo < enEfectivo)) {
          const a = autorizar ? await autorizar() : { ok: false, status: 403 };
          if (!a.ok) throw Object.assign(new DevolucionInvalida(noResponde ? 'Financiero no responde: la devolución en efectivo necesita la autorización de un supervisor.' : `La caja tiene ${saldo} y la devolución en efectivo es ${enEfectivo}: necesita la autorización de un supervisor.`), { status: a.status ?? 403, codigo: a.codigo });
          saldoAutorizadoPor = a.supervisor.id; saldoNoVerificado = noResponde;
        }
      }
    }

    const restante = venta.detalle.reduce((a, l, i) => a + l.cantidad - (devuelto.get(i) ?? 0), 0);
    for (const i of itemsDev.filter((x) => x.serie)) {
      const r = await SerieVenta.devolver(conn, { producto_id: i.producto_id, serie: i.serie, venta_id_global: idGlobalVenta, falla: i.condicion === 'con_falla', motivo: i.motivo_falla });
      if (r.advertencia) advertencias.push(r.advertencia); // garantía vencida: se advierte y no se bloquea
    }
    const tipo = itemsDev.reduce((a, i) => a + i.cantidad, 0) === restante ? 'total' : 'parcial';
    const id_global = await idGlobal();
    const [r] = await conn.query(
      'INSERT INTO devoluciones (id_global, venta_id, tipo, total, motivo, reingreso, id_solicitud, creado_por, autorizado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id_global, venta.id, tipo, total, motivo.trim(), reingreso, idSolicitud ?? null, userId ?? null, autorizadoPor ?? null]);
    for (const i of itemsDev)
      await conn.query('INSERT INTO devolucion_items (devolucion_id, linea, producto_id, nombre, cantidad, precio_unitario) VALUES (?, ?, ?, ?, ?, ?)',
        [r.insertId, i.linea, i.producto_id, i.nombre, i.cantidad, i.precio_unitario]);
    for (const x of reintegros)
      await conn.query('INSERT INTO devolucion_reintegros (devolucion_id, metodo_pago, importe) VALUES (?, ?, ?)', [r.insertId, x.forma, x.importe]);

    // Reingreso al stock (la merma no reingresa). Hasta C3 el stock se mueve directo, como en el cierre.
    // Solo si la venta tuvo descuento de stock (si no, no hay nada que revertir). Con la misma ID_Global de la venta y una
    // secuencia posterior, Stock lo retiene hasta que el descuento original esté confirmado.
    const [[conDescuento]] = await conn.query("SELECT 1 AS si FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock' LIMIT 1", [idGlobalVenta]);
    if (conDescuento) {
      await Mensajeria.publicar(conn, {
        origen: 'ventas', destino: 'stock', tipo: 'reingreso_stock', docTipo: 'venta', docIdGlobal: idGlobalVenta, docVersion: r.insertId, secuencia: 2, userId, solicitud: idSolicitud,
        contenido: { modo: reingreso, items: itemsDev.map((i) => ({ linea: i.linea, producto_id: i.producto_id, cantidad: i.cantidad, cantidad_original: venta.detalle[i.linea].cantidad, ...(i.serie && { serie: i.serie, condicion: i.condicion, motivo: i.motivo_falla }) })), user_id: userId ?? null },
      });
    }

    // Venta a cuenta corriente: el débito se anula (devolución total) o baja (parcial) en la cuenta del cliente. Con la misma ID_Global de la venta y una
    // secuencia posterior, Clientes lo retiene hasta que el débito original esté confirmado (Clientes RN37).
    const [[debitoCC]] = await conn.query("SELECT JSON_EXTRACT(contenido, '$.importe') AS importe FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'debito_venta' LIMIT 1", [idGlobalVenta]);
    if (debitoCC) {
      const aCuenta = Number(debitoCC.importe);
      await Mensajeria.publicar(conn, tipo === 'total' || total >= Number(venta.total)
        ? { origen: 'ventas', destino: 'clientes', tipo: 'anulacion_debito', docTipo: 'venta', docIdGlobal: idGlobalVenta, docVersion: r.insertId, secuencia: 2, userId, solicitud: idSolicitud, contenido: { venta_id_global: idGlobalVenta } }
        : { origen: 'ventas', destino: 'clientes', tipo: 'devolucion_debito', docTipo: 'venta', docIdGlobal: idGlobalVenta, docVersion: r.insertId, secuencia: 2, userId, solicitud: idSolicitud, contenido: { venta_id_global: idGlobalVenta, importe: Math.min(total, aCuenta) } });
    }

    // Fidelización: la devolución revierte lo acumulado y los canjes de la venta; devolver la venta de una gift card anula el instrumento (o se rechaza si tiene canjes);
    // el reintegro «vale» emite un vale por el importe elegido (no puede ser mayor al devuelto). Todo viaja como mensaje inverso con secuencia posterior.
    if (await Funciones.estaActiva('CLI-FIDEL', conn)) {
      const dev = { origen: 'ventas', destino: 'clientes', docTipo: 'venta', docIdGlobal: idGlobalVenta, docVersion: r.insertId, secuencia: 2, userId, solicitud: idSolicitud };
      const [[acum]] = await conn.query("SELECT 1 AS si FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'acumulacion_fidelizacion' LIMIT 1", [idGlobalVenta]);
      if (acum) await Mensajeria.publicar(conn, { ...dev, tipo: 'reversion_fidelizacion', contenido: { venta_id_global: idGlobalVenta } });
      const [[gift]] = await conn.query("SELECT 1 AS si FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'emision_gift_card' LIMIT 1", [idGlobalVenta]);
      if (gift) await Mensajeria.publicar(conn, { ...dev, tipo: 'reversion_emision', contenido: { venta_id_global: idGlobalVenta } });
      for (const x of reintegros.filter((v) => v.forma === 'vale'))
        await Mensajeria.publicar(conn, { ...dev, tipo: 'emision_vale', docVersion: r.insertId * 100 + 1, contenido: { cliente_id: clienteVale ?? null, importe: x.importe, venta_id_global: idGlobalVenta, devolucion_id: id_global, importe_devuelto: total } });
    }

    // Nota de crédito: solo si la venta tenía una factura aprobada que corregir.
    const original = await Factura.getBySesion(venta.mesa_id, venta.sesion_apertura, conn);
    if (original?.estado === 'aprobada') {
      nc = await Factura.create({
        mesa_id: venta.mesa_id, sesion_apertura: venta.sesion_apertura, metodo_pago: reintegros.length > 1 ? 'mixto' : reintegros[0].forma,
        tipo_comprobante: NC_DE[original.tipo_comprobante], punto_venta: original.punto_venta, doc_tipo: original.doc_tipo, doc_nro: original.doc_nro,
        condicion_iva_receptor_id: original.condicion_iva_receptor_id, receptor_nombre: original.receptor_nombre, domicilio_receptor: original.domicilio_receptor,
        importe_total: total, entorno: afipConfig.entorno, creado_por: userId, devolucion_id: r.insertId, comprobante_origen_id: original.id,
      }, conn);
      nc.original = original;
    }

    // Efectos en otros módulos: el contramovimiento del cobro y el evento contable (no para una venta no fiscal, RN84).
    const contenido = { venta_id_global: idGlobalVenta, total, tipo, reingreso, reintegros, items: itemsDev };
    // El contramovimiento del cobro viaja con la ID_Global de la venta y una secuencia posterior: Financiero lo retiene hasta que el cobro original esté
    // Confirmado (Financiero RN31). Si el cobro nunca se le informó (se instaló después de la venta), no hay nada que revertir.
    const [[cobroInformado]] = await conn.query("SELECT 1 AS si FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'cobro_registrado' AND modulo_destino = 'financiero' LIMIT 1", [idGlobalVenta]);
    if (cobroInformado) await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'financiero', tipo: 'cobro_revertido', docTipo: 'venta', docIdGlobal: idGlobalVenta, docVersion: r.insertId, secuencia: 2, userId, solicitud: idSolicitud,
      contenido: { ...contenido, motivo: motivo.trim(), devolucion_id_global: id_global, saldo_autorizado_por: saldoAutorizadoPor, saldo_no_verificado: saldoNoVerificado, terminal_id: terminalId } });
    if (venta.condicion_fiscal !== 'no_fiscal') await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'contable', tipo: 'venta_devuelta', docTipo: 'devolucion', docIdGlobal: id_global, userId, solicitud: idSolicitud, contenido });
    await conn.commit();
    devolucion = { id: r.insertId, id_global, tipo, total, reingreso };
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY' && /solicitud/.test(err.message)) throw new DevolucionInvalida('Esta devolución ya fue registrada con esa clave de solicitud.');
    throw err;
  } finally {
    conn.release();
  }
  Mensajeria.despertar();

  // Fuera de la transacción: si ARCA falla, la devolución ya está y la nota de crédito queda para reintentar.
  let notaCredito = null;
  if (nc) {
    try {
      const resultado = await afipService.emitirFactura({
        tipoComprobante: nc.tipo_comprobante, docTipo: nc.doc_tipo, docNro: nc.doc_nro, condicionIvaReceptorId: nc.condicion_iva_receptor_id,
        importeTotal: devolucion.total, idIntento: idSolicitud, facturaId: nc.id,
        comprobanteAsociado: { Tipo: nc.original.tipo_comprobante, PtoVta: nc.original.punto_venta, Nro: nc.original.numero },
      });
      await Factura.updateResultado(nc.id, resultado);
    } catch (err) {
      await Factura.updateResultado(nc.id, { estado: 'error', importeTotal: devolucion.total, observaciones: err.message });
    }
    notaCredito = await Factura.getById(nc.id);
  }
  return { devolucion, reintegros, nota_credito: notaCredito, ...(advertencias.length && { advertencias }) };
};

const listar = async (idGlobalVenta) => {
  const [devs] = await pool.query(
    `SELECT d.* FROM devoluciones d JOIN ventas v ON v.id = d.venta_id WHERE v.id_global = ? ORDER BY d.id`, [idGlobalVenta]);
  for (const d of devs) {
    d.items = (await pool.query('SELECT linea, producto_id, nombre, cantidad, precio_unitario FROM devolucion_items WHERE devolucion_id = ?', [d.id]))[0];
    d.reintegros = (await pool.query('SELECT metodo_pago, importe FROM devolucion_reintegros WHERE devolucion_id = ?', [d.id]))[0];
    d.nota_credito = (await pool.query('SELECT id, estado, numero, cae, tipo_comprobante FROM facturas WHERE devolucion_id = ?', [d.id]))[0][0] ?? null;
  }
  return devs;
};

module.exports = { devolver, listar, necesitaAutorizacion, DevolucionInvalida, NC_DE };
