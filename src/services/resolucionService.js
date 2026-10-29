const pool = require('../config/db');
const registro = require('../instancias/registro');
const wsfeClient = require('../afip/wsfeClient');
const Factura = require('../models/facturaModel');
const Notificacion = require('../models/notificacionModel');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');

// Resolución de intentos indeterminados (Ventas RF47, RN51, RN53, RN54, RN57). Un intento queda
// indeterminado cuando se cortó la comunicación después de enviar el pedido de CAE: no se sabe si ARCA lo
// autorizó. Su clave queda "resolviendo" (no emite nadie más con ella) hasta consultar a ARCA por número.
const SISTEMA = { username: 'sistema' };
const CONSULTAS_MS = [5000, 15000, 30000, 60000]; // desde que se abrió; después, cada 5 minutos
const CADA_MS = 300000;
const SEPARACION_MS = 60000; // dos "no existe" separadas al menos así liberan el número
const ALERTA_MS = 600000;    // sin resolver a los 10 minutos: alerta crítica

const parteDeClave = (clave) => { const [pto, tipo] = clave.split(':'); return { pto: Number(pto), tipo: Number(tipo) }; };
const proxima = (consultas) => Date.now() + (CONSULTAS_MS[consultas] === undefined ? CADA_MS : CONSULTAS_MS[consultas] - (CONSULTAS_MS[consultas - 1] ?? 0));

// Se corta después de enviar: el número queda bloqueado y la clave "resolviendo".
const abrir = async ({ idIntento, clave, numero, facturaId }) => {
  await pool.query(
    `INSERT INTO intento_emision (id_intento, clave, numero, estado, factura_id, consultas, proxima_consulta_ms)
     VALUES (?, ?, ?, 'indeterminado', ?, 0, ?)
     ON DUPLICATE KEY UPDATE clave = VALUES(clave), numero = VALUES(numero), estado = 'indeterminado',
       factura_id = VALUES(factura_id), consultas = 0, proxima_consulta_ms = VALUES(proxima_consulta_ms), inexistente_desde_ms = NULL, alertado = 0`,
    [idIntento, clave, numero, facturaId ?? null, Date.now() + CONSULTAS_MS[0]]
  );
  await pool.query("UPDATE secuenciador_claves SET estado = 'resolviendo', propietario = NULL WHERE clave = ?", [clave]);
  await auditar(null, { modulo: 'facturacion', accion: 'numero_bloqueado', entidad: 'intento', entidad_id: idIntento, detalle: `${clave} N° ${numero}` }, SISTEMA);
};

// La clave vuelve a "libre" solo si no le quedan intentos indeterminados.
const liberarSiNoQuedan = async (clave) => {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM intento_emision WHERE clave = ? AND estado = 'indeterminado'", [clave]);
  if (!n) await pool.query("UPDATE secuenciador_claves SET estado = 'libre', propietario = NULL, vence_ms = 0 WHERE clave = ? AND estado = 'resolviendo'", [clave]);
  return !n;
};

// ARCA autorizó el comprobante después de la respuesta perdida: se completa la factura (EX38).
const completar = async (intento, info) => {
  const resultado = { estado: 'aprobada', numero: intento.numero, cae: info.cae, caeVencimiento: info.caeVencimiento, observaciones: 'Resuelto por consulta a ARCA (respuesta tardía).' };
  if (intento.factura_id) {
    const f = await Factura.getById(intento.factura_id);
    Object.assign(resultado, { importeNeto: f.importe_neto, importeIva: f.importe_iva, importeTotal: f.importe_total });
    await Factura.updateResultado(intento.factura_id, resultado);
  }
  await pool.query("UPDATE intento_emision SET estado = 'autorizado', resultado = ?, proxima_consulta_ms = NULL WHERE id = ?", [JSON.stringify(resultado), intento.id]);
  await liberarSiNoQuedan(intento.clave);
  await Notificacion.resolverPorClave(`intento-indeterminado-${intento.id_intento}`, 'ARCA autorizó el comprobante');
  await Notificacion.crear({ modulo: 'ventas', tipo: 'respuesta_tardia', severidad: 'media', roles: ['administrador', 'encargado', 'cajero'],
    mensaje: `ARCA autorizó el comprobante N° ${intento.numero} (${intento.clave}) después de la demora: entregá la factura al cliente.`, clave: `respuesta-tardia-${intento.id_intento}` });
  await auditar(null, { modulo: 'facturacion', accion: 'intento_autorizado_por_consulta', entidad: 'intento', entidad_id: intento.id_intento, detalle: `N° ${intento.numero}` }, SISTEMA);
};

// ARCA no tiene ese número en dos consultas separadas: no se autorizó, el número se reutiliza (RN53).
const liberar = async (intento, motivo, actor) => {
  await pool.query("UPDATE intento_emision SET estado = 'rechazado', proxima_consulta_ms = NULL WHERE id = ?", [intento.id]);
  await liberarSiNoQuedan(intento.clave);
  await Notificacion.resolverPorClave(`intento-indeterminado-${intento.id_intento}`, motivo);
  await auditar(null, { modulo: 'facturacion', accion: 'numero_liberado', entidad: 'intento', entidad_id: intento.id_intento, detalle: `N° ${intento.numero}: ${motivo}` }, actor);
};

const consultarUno = async (intento) => {
  const { pto, tipo } = parteDeClave(intento.clave);
  const ahora = Date.now();
  let info;
  try {
    info = await wsfeClient.compConsultar(pto, tipo, intento.numero);
  } catch (err) {
    // Sin conexión con ARCA: el intento sigue a la espera (EX02) y se vuelve a consultar.
    logger.warn(`[facturacion] consulta a ARCA falló (${intento.clave} N° ${intento.numero}): ${err.message}`);
    await pool.query('UPDATE intento_emision SET consultas = consultas + 1, proxima_consulta_ms = ? WHERE id = ?', [proxima(intento.consultas + 1), intento.id]);
    return 'sin_conexion';
  }
  await auditar(null, { modulo: 'facturacion', accion: 'consulta_arca', entidad: 'intento', entidad_id: intento.id_intento, detalle: `${intento.clave} N° ${intento.numero}: ${info ? info.resultado : 'inexistente'}` }, SISTEMA);

  if (info && info.resultado === 'A') { await completar(intento, info); return 'autorizado'; }
  // Rechazado u omitido por ARCA, o inexistente: cuenta como "no autorizado".
  if (!info || info.resultado !== 'A') {
    if (intento.inexistente_desde_ms && ahora - Number(intento.inexistente_desde_ms) >= SEPARACION_MS) {
      await liberar(intento, 'ARCA no tiene el comprobante en dos consultas separadas', SISTEMA);
      return 'liberado';
    }
    await pool.query('UPDATE intento_emision SET consultas = consultas + 1, proxima_consulta_ms = ?, inexistente_desde_ms = COALESCE(inexistente_desde_ms, ?) WHERE id = ?',
      [proxima(intento.consultas + 1), ahora, intento.id]);
    return 'pendiente';
  }
};

// Una vuelta del trabajador: consulta los intentos a los que ya les toca y alerta los de más de 10 minutos.
const procesarIndeterminados = async () => {
  const [pendientes] = await pool.query("SELECT * FROM intento_emision WHERE estado = 'indeterminado' AND proxima_consulta_ms <= ? ORDER BY id", [Date.now()]);
  const resultados = [];
  for (const intento of pendientes) resultados.push(await consultarUno(intento));

  const [viejos] = await pool.query("SELECT * FROM intento_emision WHERE estado = 'indeterminado' AND alertado = 0 AND created_at < ?", [new Date(Date.now() - ALERTA_MS)]);
  for (const i of viejos) {
    await Notificacion.crear({ modulo: 'ventas', tipo: 'clave_sin_resolver', severidad: 'critica', roles: ['administrador'],
      mensaje: `La clave ${i.clave} sigue "Resolviendo" hace más de 10 minutos (comprobante N° ${i.numero}): resolvela a mano con autorización de un supervisor.`, clave: `intento-indeterminado-${i.id_intento}` });
    await pool.query('UPDATE intento_emision SET alertado = 1 WHERE id = ?', [i.id]);
  }
  return resultados;
};

// Resolución manual de una clave bloqueada, con motivo (la autorización de supervisor la pide la ruta, RN57).
const liberarClave = async (clave, motivo, actor) => {
  const [intentos] = await pool.query("SELECT * FROM intento_emision WHERE clave = ? AND estado = 'indeterminado'", [clave]);
  for (const i of intentos) await liberar(i, `liberación manual: ${motivo}`, actor);
  await pool.query("UPDATE secuenciador_claves SET estado = 'libre', propietario = NULL, vence_ms = 0 WHERE clave = ? AND estado = 'resolviendo'", [clave]);
  await Notificacion.resolverPorClave(`numeracion-${clave}`, 'Reconciliada a mano');
  return intentos.length;
};

// Vista de las claves bloqueadas con sus intentos pendientes (RF47).
const claves = async () => {
  const [filas] = await pool.query('SELECT * FROM secuenciador_claves ORDER BY clave');
  const [intentos] = await pool.query("SELECT id_intento, clave, numero, consultas, factura_id, created_at FROM intento_emision WHERE estado = 'indeterminado' ORDER BY id");
  return filas.map((c) => ({ ...c, intentos_pendientes: intentos.filter((i) => i.clave === c.clave) }));
};

// Numeración local contra la de ARCA (RN51, EX42): al iniciar el día, tras un reinicio o un intento
// indeterminado. Si difieren, la clave queda "resolviendo" y se avisa con los números sin registro local.
// shortcut: sin comprobantes locales para la clave (instancia nueva, o recién migrada de otro sistema) se
// adopta la numeración de ARCA sin bloquear; sacar si se quiere exigir el alta manual del primer número.
const validarNumeracion = async (puntoVenta, tipo) => {
  const [[{ local }]] = await pool.query("SELECT MAX(numero) AS local FROM facturas WHERE punto_venta = ? AND tipo_comprobante = ? AND estado = 'aprobada'", [puntoVenta, tipo]);
  if (local === null) return { ok: true, adoptada: true };
  const arca = await wsfeClient.compUltimoAutorizado(puntoVenta, tipo);
  const clave = `${puntoVenta}:${tipo}:CAE`;
  if (arca === Number(local)) {
    await Notificacion.resolverPorClave(`numeracion-${clave}`, 'La numeración coincide con ARCA');
    return { ok: true, local: Number(local), arca };
  }
  await pool.query("INSERT IGNORE INTO secuenciador_claves (clave, estado, vence_ms) VALUES (?, 'libre', 0)", [clave]);
  await pool.query("UPDATE secuenciador_claves SET estado = 'resolviendo', propietario = NULL WHERE clave = ?", [clave]);
  const faltan = arca > Number(local) ? `Faltan en el registro local los N° ${Number(local) + 1} a ${arca}` : `El registro local llega al N° ${local} y ARCA al ${arca}`;
  await Notificacion.crear({ modulo: 'ventas', tipo: 'numeracion_distinta', severidad: 'alta', roles: ['administrador'], mensaje: `La numeración de ${clave} no coincide con ARCA. ${faltan}. No se emite hasta reconciliar.`, clave: `numeracion-${clave}` });
  await auditar(null, { modulo: 'facturacion', accion: 'numeracion_distinta', entidad: 'clave', entidad_id: clave, detalle: faltan }, SISTEMA);
  return { ok: false, local: Number(local), arca };
};

// Trabajador propio de Ventas (la mensajería es de la capa de Usuarios y no puede llamar hacia arriba).
const hoy = new Map(); // instancia -> fecha ya validada
const vuelta = async () => {
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        await procesarIndeterminados();
        await require('./caeaService').mantenimiento();
        await require('./precioService').aplicarVencidas();
        const dia = new Date().toDateString();
        if (hoy.get(inst.codigo) !== dia) {
          hoy.set(inst.codigo, dia);
          const config = require('../config/afipConfig');
          const afip = require('./afipService');
          for (const tipo of afip.TIPOS_VALIDOS_POR_CONDICION[config.condicionIvaEmisor]) {
            await validarNumeracion(config.puntoVenta, tipo).catch((e) => { hoy.delete(inst.codigo); logger.warn(`[facturacion] no se pudo validar la numeración: ${e.message}`); });
          }
        }
      } catch (err) {
        logger.error(`[facturacion] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[facturacion] ${e.message}`)), 5000);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { abrir, procesarIndeterminados, liberarClave, claves, validarNumeracion, iniciar, vuelta, CONSULTAS_MS };
