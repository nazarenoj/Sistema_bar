const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Proveedores = require('../src/compras/proveedorService');

let api, pool, cerrar, adm, gerente, administrativo, deposito;
const CUIT = '30711111111', CUIT2 = '20123456786';
// CBU válido de 22 dígitos (bloques con su dígito verificador).
const cbuDe = (b1, b2) => { const dv = (d, p) => (10 - (d.reduce((acc, x, i) => acc + x * p[i], 0) % 10)) % 10; const x = b1.split('').map(Number), y = b2.split('').map(Number); return `${b1}${dv(x, [7, 1, 3, 9, 7, 1, 3])}${b2}${dv(y, [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3])}`; };
const CBU = cbuDe('0170001', '1234567890123');

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  deposito = await usuario(api, pool, 'dani', 'deposito');
});
after(async () => { await cerrar(); });

const prov = (b, t = administrativo) => api('POST', '/api/compras/proveedores', { token: t.token, body: { cuit: CUIT, razon_social: 'Tostadores del Sur SA', consultar_arca: false, ...b } });

test('Compras: sin instalar el módulo no hay proveedores; instalado sin Stock ni Financiero, funciona', async () => {
  assert.equal((await api('GET', '/api/compras/proveedores', { token: adm.token })).status, 409);
  const r = await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await api('GET', '/api/compras/proveedores', { token: adm.token })).status, 200);
});

test('Compras.RN16: el CBU se valida por sus dígitos verificadores; el alias por su formato', () => {
  assert.equal(Proveedores.cbuValido(CBU), true);
  assert.equal(Proveedores.cbuValido(`${CBU.slice(0, 21)}${(Number(CBU[21]) + 1) % 10}`), false);
  assert.equal(Proveedores.cbuValido('123'), false);
  assert.equal(Proveedores.aliasValido('cafe.sur.mp'), true);
  assert.equal(Proveedores.aliasValido('x'), false);
});

test('Compras.RF01/RN02/RN16: el CUIT identifica a un solo proveedor y lleva dígito verificador; el CBU o alias, también', async () => {
  assert.equal((await prov({ cuit: '123' })).status, 400);
  assert.equal((await prov({ cuit: '30711111112' })).json.codigo, 'CUIT_INVALIDO'); // dígito verificador
  assert.equal((await prov({ razon_social: '' })).status, 400);
  assert.equal((await prov({ cbu_alias: '1234567890123456789012' })).json.codigo, 'CBU_INVALIDO');
  assert.equal((await prov({ tipo: 'otro' })).status, 400);
  assert.equal((await prov({ condicion_pago_dias: -1 })).status, 400);
  assert.equal((await prov({ rubro_id: 9999 })).status, 404);
  assert.equal((await prov({ contactos: [{ nombre: 'Ana', email: 'ana-sin-arroba' }] })).status, 400);
  assert.equal((await prov({}, deposito)).status, 403); // sin el permiso
  const ok = await prov({ cbu_alias: CBU, condicion_pago_dias: 30, tipo: 'ambos', condicion_iva: 'Responsable Inscripto', contactos: [{ nombre: 'Ana', telefono: '11 5555-0000', email: 'ana@sur.com' }], retenciones: 'Agente de retención' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.cuit, ok.json.tipo, ok.json.condicion_pago_dias, ok.json.verificado_arca, ok.json.estado], [CUIT, 'ambos', 30, false, 'activo']);
  assert.match(ok.json.aviso ?? 'sin aviso', /sin aviso/); // consultar_arca:false no consulta
  const dup = await prov({ razon_social: 'Otra razón' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.codigo, 'CUIT_DUPLICADO');
  assert.equal(dup.json.detalle.proveedor.id, ok.json.id);
  assert.equal((await prov({ cuit: CUIT2, razon_social: 'Lácteos del Valle', cbu_alias: 'lacteos.valle' })).status, 201);
});

test('Compras.RF01/EX: con el padrón de ARCA completa los datos fiscales; sin conexión queda «no verificado» y se puede verificar después', async () => {
  const Padron = require('../src/services/padronService');
  const original = Padron.consultar;
  Padron.consultar = async () => ({ estado: 'ok', razon_social: 'MOLINO HARINERO SRL', condicion_iva: 'Responsable Inscripto', domicilio: 'Ruta 5 km 10, Luján' });
  try {
    const r = await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: '33693450239' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual([r.json.razon_social, r.json.condicion_iva, r.json.verificado_arca], ['MOLINO HARINERO SRL', 'Responsable Inscripto', true]);
  } finally { Padron.consultar = original; }
  Padron.consultar = async () => ({ estado: 'sin_conexion' });
  try {
    const sin = await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: '30500010912', razon_social: 'Distribuidora Norte' } });
    assert.equal(sin.status, 201, JSON.stringify(sin.json));
    assert.equal(sin.json.verificado_arca, false);
    assert.match(sin.json.aviso, /sin verificar/);
    const vf = await api('POST', `/api/compras/proveedores/${sin.json.id}/verificar-arca`, { token: administrativo.token });
    assert.match(vf.json.aviso, /pendiente de verificar/); // sigue sin conexión
    Padron.consultar = async () => ({ estado: 'ok', razon_social: 'DISTRIBUIDORA NORTE SA', condicion_iva: 'Monotributo' });
    const vf2 = await api('POST', `/api/compras/proveedores/${sin.json.id}/verificar-arca`, { token: administrativo.token });
    assert.deepEqual([vf2.json.verificado_arca, vf2.json.razon_social], [true, 'DISTRIBUIDORA NORTE SA']);
  } finally { Padron.consultar = original; }
});

test('Compras.RF17/RN29: los datos de entrega y el rubro son del proveedor y editarlos pide su propio permiso', async () => {
  const [p] = (await api('GET', `/api/compras/proveedores?q=${CUIT}`, { token: gerente.token })).json;
  const put = (b, t = administrativo) => api('PUT', `/api/compras/proveedores/${p.id}`, { token: t.token, body: b });
  const rubro = (await api('GET', '/api/compras/rubros', { token: gerente.token })).json.find((r) => r.nombre === 'Café y tostadores').id;
  const ok = await put({ rubro_id: rubro, plazo_entrega_dias: 2, dias_entrega: ['lun', 'mie', 'vie'], hora_corte: '11:30', pedido_minimo: 50000 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.rubro, ok.json.plazo_entrega_dias, ok.json.dias_entrega, ok.json.hora_corte, ok.json.pedido_minimo], ['Café y tostadores', 2, ['lun', 'mie', 'vie'], '11:30', 50000]);
  assert.equal((await put({ plazo_entrega_dias: -1 })).status, 400);
  assert.equal((await put({ dias_entrega: ['lunes'] })).status, 400);
  assert.equal((await put({ hora_corte: '25:00' })).status, 400);
  assert.equal((await put({ pedido_minimo: -5 })).status, 400);
  assert.equal((await put({ cuit: '20123456786' })).status, 409); // el CUIT no se cambia
  // Sin el permiso de entrega (el rol Depósito solo ve), el resto del proveedor sí se edita pero la entrega no.
  await pool.query("INSERT INTO rol_permisos (rol_id, permiso, nivel) SELECT id, 'compras.proveedores.gestionar', 'permitido' FROM roles WHERE codigo = 'deposito'");
  const sin = await put({ plazo_entrega_dias: 5 }, deposito);
  assert.equal(sin.status, 403);
  assert.equal(sin.json.codigo, 'SIN_PERMISO');
  assert.equal((await put({ condicion_pago_dias: 45 }, deposito)).status, 200);
  assert.equal((await put({ plazo_entrega_dias: null, dias_entrega: [], hora_corte: null, pedido_minimo: null })).json.dias_entrega.length, 0);
  // Rubros configurables.
  assert.equal((await api('POST', '/api/compras/rubros', { token: gerente.token, body: { nombre: 'Café y tostadores' } })).status, 409);
  const nuevo = await api('POST', '/api/compras/rubros', { token: gerente.token, body: { nombre: 'Insumos de barra' } });
  assert.equal(nuevo.status, 201);
  assert.equal((await api('PUT', `/api/compras/rubros/${nuevo.json.id}`, { token: gerente.token, body: { activo: false } })).json.activo, false);
  assert.equal((await api('PUT', `/api/compras/proveedores/${p.id}`, { token: administrativo.token, body: { rubro_id: nuevo.json.id } })).status, 404); // rubro desactivado
  assert.equal((await api('POST', '/api/compras/rubros', { token: administrativo.token, body: { nombre: 'X' } })).status, 403);
});

test('Compras.RN17/RN18: los proveedores se filtran y desactivan; la configuración se valida y los cambios quedan auditados', async () => {
  const todos = (await api('GET', '/api/compras/proveedores', { token: gerente.token })).json;
  assert.ok(todos.length >= 4);
  assert.equal((await api('GET', '/api/compras/proveedores?q=Lácteos', { token: gerente.token })).json.length, 1);
  assert.equal((await api('GET', '/api/compras/proveedores?q=30711', { token: gerente.token })).json.length, 1);
  const p = todos.find((x) => x.cuit === CUIT2);
  assert.equal((await api('POST', `/api/compras/proveedores/${p.id}/desactivar`, { token: administrativo.token })).json.estado, 'inactivo');
  assert.equal((await api('GET', '/api/compras/proveedores?estado=inactivo', { token: gerente.token })).json.length, 1);
  assert.equal((await api('POST', `/api/compras/proveedores/${p.id}/activar`, { token: administrativo.token })).json.estado, 'activo');
  const put = (b, t = gerente) => api('PUT', '/api/compras/config', { token: t.token, body: b });
  assert.deepEqual([(await api('GET', '/api/compras/config', { token: gerente.token })).json.actualizacion_costo, (await api('GET', '/api/compras/config', { token: gerente.token })).json.tolerancia_redondeo], ['siempre', 0.05]);
  assert.equal((await put({ actualizacion_costo: 'a veces' })).status, 400);
  assert.equal((await put({ tolerancia_redondeo: -1 })).status, 400);
  assert.equal((await put({ retencion_solicitudes_dias: 30 })).status, 400);
  assert.equal((await put({ actualizacion_costo: 'solo_si_aumenta' }, administrativo)).status, 403);
  const ok = await put({ actualizacion_costo: 'con_confirmacion', variacion_costo_pct: 15, importe_aprobacion_op: 100000, bloquear_cae_invalido: true });
  assert.deepEqual([ok.json.actualizacion_costo, ok.json.variacion_costo_pct, ok.json.importe_aprobacion_op, ok.json.bloquear_cae_invalido], ['con_confirmacion', 15, 100000, true]);
  const acciones = new Set((await pool.query("SELECT accion FROM auditoria WHERE modulo = 'compras'"))[0].map((a) => a.accion));
  for (const a of ['alta_proveedor', 'modificacion_proveedor', 'desactivar_proveedor', 'cambio_configuracion']) assert.ok(acciones.has(a), `falta auditar ${a}`);
});
