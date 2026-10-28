const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// Antes de armar la app: el emisor de la prueba es monotributista, punto de venta 1 (Factura C).
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp } = require('./ayudas');

let pool, cerrar, afip, wsfe, Secuenciador;
let ultimo = 0, enVuelo = 0, maxEnVuelo = 0, rechazarProxima = false, cortarProxima = false, solicitudes = 0;

before(async () => {
  ({ pool, cerrar } = await iniciarApp());
  afip = require('../src/services/afipService');
  wsfe = require('../src/afip/wsfeClient');
  Secuenciador = require('../src/services/secuenciadorService');
  // ARCA simulado: un último autorizado y un pedido de CAE lento (para ver la concurrencia).
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.solicitarCAE = async ({ item }) => {
    solicitudes++;
    enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
    await new Promise((r) => setTimeout(r, 30));
    enVuelo--;
    if (cortarProxima) { cortarProxima = false; throw new Error('timeout'); }
    if (rechazarProxima) { rechazarProxima = false; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: 1, Msg: 'no' }] } }] } }; }
    ultimo = item.CbteDesde;
    return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } };
  };
});
after(async () => { await cerrar(); });

const emitir = (extra = {}) => afip.emitirFactura({ tipoComprobante: 11, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5, importeTotal: 100, ...extra });

test('Ventas.RN12/RN49/RN56: 5 emisiones simultáneas sobre la misma clave salen correlativas, una en vuelo a la vez', async () => {
  const base = ultimo;
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => emitir()));
  assert.deepEqual(rs.map((r) => r.numero).sort((a, b) => a - b), [base + 1, base + 2, base + 3, base + 4, base + 5]);
  assert.equal(maxEnVuelo, 1);
  assert.ok(rs.every((r) => r.estado === 'aprobada'));
  assert.equal((await Secuenciador.listar()).find((c) => c.clave === '1:11:CAE').estado, 'libre');
});

test('Ventas.EX03: un rechazo de ARCA libera el número: el próximo comprobante lo usa', async () => {
  rechazarProxima = true;
  const r1 = await emitir();
  assert.equal(r1.estado, 'rechazada');
  const r2 = await emitir();
  assert.equal(r2.estado, 'aprobada');
  assert.equal(r2.numero, r1.numero);
});

test('Ventas.RN52: repetir un intento ya autorizado devuelve el mismo comprobante sin volver a ARCA', async () => {
  const antes = solicitudes;
  const a = await emitir({ idIntento: 'intento-repetido-1' });
  const b = await emitir({ idIntento: 'intento-repetido-1' });
  assert.equal(solicitudes, antes + 1);
  assert.deepEqual(b, a);
  const [[i]] = await pool.query("SELECT estado, numero FROM intento_emision WHERE id_intento = 'intento-repetido-1'");
  assert.equal(i.estado, 'autorizado');
  assert.equal(i.numero, a.numero);
});

test('Ventas.RN52: un corte después de enviar deja el intento Indeterminado y la clave libre', async () => {
  cortarProxima = true;
  await assert.rejects(emitir({ idIntento: 'intento-cortado-1' }), /timeout/);
  const [[i]] = await pool.query("SELECT estado FROM intento_emision WHERE id_intento = 'intento-cortado-1'");
  assert.equal(i.estado, 'indeterminado');
  assert.equal((await emitir()).estado, 'aprobada'); // la clave no quedó trabada
});

test('Ventas.RN50: el arrendamiento vencido de otro se toma; el vigente hace esperar y vence la espera', async () => {
  const clave = '9:11:CAE';
  await pool.query("INSERT INTO secuenciador_claves (clave, estado, propietario, vence_ms) VALUES (?, 'ocupada', 'caido', ?)", [clave, Date.now() - 1000]);
  assert.equal(await Secuenciador.conClave({ puntoVenta: 9, tipo: 11 }, async () => 'tomada'), 'tomada');

  await pool.query("UPDATE secuenciador_claves SET estado = 'ocupada', propietario = 'vivo', vence_ms = ? WHERE clave = ?", [Date.now() + 60000, clave]);
  await assert.rejects(Secuenciador.conClave({ puntoVenta: 9, tipo: 11 }, async () => 'x', { esperaMs: 150 }), (e) => e.codigo === 'CLAVE_OCUPADA');
});

test('Ventas.RN50: mientras la solicitud sigue en curso el arrendamiento se renueva', async () => {
  const clave = '8:11:CAE';
  await Secuenciador.conClave({ puntoVenta: 8, tipo: 11 }, async () => {
    const [[a]] = await pool.query('SELECT vence_ms FROM secuenciador_claves WHERE clave = ?', [clave]);
    await new Promise((r) => setTimeout(r, 120));
    const [[b]] = await pool.query('SELECT vence_ms FROM secuenciador_claves WHERE clave = ?', [clave]);
    assert.ok(Number(b.vence_ms) > Number(a.vence_ms));
  }, { renovarMs: 40 });
});

test('Ventas.RN14: la Factura A exige receptor Responsable Inscripto con CUIT; el consumidor final no pasa el tope', async () => {
  const datos = { tipoComprobante: 1, docTipo: 80, condicionIvaReceptorId: 1, importeTotal: 100 };
  await afip.validarReceptor(datos);
  await assert.rejects(afip.validarReceptor({ ...datos, condicionIvaReceptorId: 5 }), /Responsable Inscripto/);
  await assert.rejects(afip.validarReceptor({ ...datos, docTipo: 96 }), /CUIT/);
  // El tope (0 = sin control) se carga como parámetro.
  await pool.query("UPDATE parametros SET valor = '500' WHERE clave = 'tope_consumidor_final'");
  require('../src/models/parametroModel').invalidar();
  await assert.rejects(emitir({ importeTotal: 501 }), /tope/);
  assert.equal((await emitir({ importeTotal: 500 })).estado, 'aprobada');
  assert.equal((await emitir({ importeTotal: 900, docTipo: 96, docNro: '30111222' })).estado, 'aprobada'); // identificado
});
