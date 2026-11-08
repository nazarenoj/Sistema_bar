process.env.AFIP_CONDICION_IVA_EMISOR = process.env.AFIP_CONDICION_IVA_EMISOR || 'monotributista';
process.env.AFIP_PUNTO_VENTA = process.env.AFIP_PUNTO_VENTA || '1';
const assert = require('node:assert/strict');
const { esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { fechaLocal } = require('../src/contable/comun');

// Prepara una instancia con Contable instalado e iniciado hoy, y un vendedor de cuentas de 250 (2 x $100 + 1 x $50, IVA 21% incluido).
const preparar = async (api, pool, { perfil = 'cafeteria', antes = null } = {}) => {
  const wsfe = require('../src/afip/wsfeClient');
  let ultimo = 0;
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.solicitarCAE = async ({ item }) => { ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } }; };
  const adm = await usuario(api, pool, 'adm', 'administrador');
  const gerente = await usuario(api, pool, 'gero', 'gerente');
  const cajero = await usuario(api, pool, 'cami', 'cajero');
  if (antes) await antes({ adm, gerente, cajero }); // módulos y funciones que el plan de cuentas tiene en cuenta al iniciar
  assert.equal((await api('POST', '/api/modulos/contable/instalar', { token: adm.token })).status, 200);
  const hoy = fechaLocal();
  assert.equal((await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: hoy, perfil } })).status, 200);
  const cuentas = (await api('GET', '/api/contable/cuentas', { token: gerente.token })).json;
  let n = 0;
  const vender = async (metodo = 'efectivo') => {
    const mesa = (await api('POST', '/api/mesas', { token: adm.token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
    const a = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: `A ${n}`, precio: 100, stock: 10 } })).json;
    const b = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: `B ${n}`, precio: 50, stock: 10 } })).json;
    const pedido = (await api('POST', '/api/pedidos', { token: adm.token, body: { mesa_id: mesa.id } })).json;
    await api('POST', `/api/pedidos/${pedido.id}/productos`, { token: adm.token, body: { productos: [{ producto_id: a.id, cantidad: 2 }, { producto_id: b.id, cantidad: 1 }] } });
    const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token: adm.token, headers: { 'X-ID-Solicitud': `venta-${n}-${Math.random().toString(36).slice(2, 8)}` }, body: { metodo_pago: metodo } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await esperarMensajes(pool);
    return r.json.venta_id_global;
  };
  const clave = (c) => cuentas.find((x) => x.clave === c);
  const asientoDe = async (idDoc, tipo = null) => {
    const [[o]] = await pool.query(`SELECT asiento_id FROM con_asiento_origen WHERE id_documento = ? ${tipo ? 'AND tipo_documento = ?' : ''} ORDER BY id LIMIT 1`, tipo ? [idDoc, tipo] : [idDoc]);
    return o ? (await api('GET', `/api/contable/asientos/${o.asiento_id}`, { token: gerente.token })).json : null;
  };
  const linea = (a, k, lado) => a.lineas.filter((l) => l.cuenta_id === clave(k).id).reduce((s, l) => s + l[lado], 0);
  return { adm, gerente, cajero, hoy, cuentas, clave, vender, asientoDe, linea };
};

module.exports = { preparar };
