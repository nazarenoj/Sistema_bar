const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const { FUNCIONES, PERFILES, PREFIJOS, porId } = require('../src/funciones/catalogo');
const { MODULOS } = require('../src/modulos/catalogo');
const Funciones = require('../src/funciones/servicio');
const { hashCodigo } = require('../src/utils/credenciales');

let api, pool, cerrar, admin, otroAdmin, empleado;
const CLAVE = 'clave-larga-1';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const crear = async (u, rol, pin) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol, pin_hash) VALUES (?, ?, ?, ?)', [u, await bcrypt.hash(CLAVE, 4), rol, pin ? hashCodigo(pin) : null]);
    return r.insertId;
  };
  await crear('jefe', 'admin', '1111'); await crear('jefa', 'admin', '2222'); await crear('emp', 'empleado');
  const entrar = async (u) => (await api('POST', '/api/auth/login', { body: { username: u, password: CLAVE } })).json.token;
  admin = await entrar('jefe'); otroAdmin = await entrar('jefa'); empleado = await entrar('emp');
  // La instancia arranca con el perfil Cafetería (versión 1), como después del alta.
  await Funciones.aplicarPerfil(pool, 'cafeteria', { username: 'alta' }, 'alta');
});
after(async () => { await cerrar(); });

const cambiar = (body, token = admin) => api('POST', '/api/funciones/cambiar', { token, body });
const estado = async () => (await api('GET', '/api/funciones', { token: admin })).json;
const de = (e, id) => e.funciones.find((f) => f.id === id);

test('Usuarios.RN32: el catálogo carga el Anexo A.1: IDs únicos, prefijo del módulo dueño y requisitos que existen', () => {
  assert.equal(FUNCIONES.length, 61);
  assert.equal(new Set(FUNCIONES.map((f) => f.id)).size, FUNCIONES.length);
  for (const f of FUNCIONES) {
    assert.equal(PREFIJOS[f.id.split('-')[0]], f.modulo, f.id);
    assert.ok(MODULOS[f.modulo], f.id);
    for (const r of f.funciones) assert.ok(porId[r], `${f.id} requiere ${r}`);
    for (const c of f.condicional) assert.ok(porId[c.funcion] && MODULOS[c.siModulo], f.id);
    for (const m of f.modulos) assert.ok(MODULOS[m], f.id);
  }
  assert.deepEqual(FUNCIONES.filter((f) => f.sanitaria).map((f) => f.id).sort(), ['STK-ALERGENOS', 'STK-LOTES', 'STK-TEMP', 'STK-TRAZA', 'VEN-ALERGENOS']);
});

test('Usuarios.RN25: una función sin su módulo o su requisito se muestra deshabilitada con la leyenda "Requiere: …"', async () => {
  const e = await estado();
  assert.match(de(e, 'VEN-CC').motivo, /Requiere: módulo Clientes y CC/);
  assert.match(de(e, 'CMP-PEDIDOS').motivo, /Requiere: módulo Compras/);
  assert.equal(de(e, 'VEN-SALON').activa, true);
  assert.equal(de(e, 'VEN-KDS').activa, false);
  assert.equal(de(e, 'VEN-KDS').deshabilitada, false);
  // Requisito condicional: solo rige con el módulo instalado.
  const sinFin = Funciones.evaluar(new Map([['VEN-DIVISA', true]]), new Set(['ventas']));
  assert.equal(sinFin.find((f) => f.id === 'VEN-DIVISA').activa, true);
  const conFin = Funciones.evaluar(new Map([['VEN-DIVISA', true]]), new Set(['ventas', 'financiero']));
  assert.match(conFin.find((f) => f.id === 'VEN-DIVISA').motivo, /Requiere: FIN-MONEDA-EXT \(porque Financiero está instalado\)/);
});

test('Usuarios.RN24/EX29: solo el Administrador cambia funciones y el intento de otro queda auditado', async () => {
  const r = await cambiar({ activar: ['VEN-KDS'] }, empleado);
  assert.equal(r.status, 403);
  assert.equal((await api('POST', '/api/funciones/perfil', { token: empleado, body: { perfil: 'cafeteria' } })).status, 403);
  assert.equal(de(await estado(), 'VEN-KDS').activa, false);
  const [aud] = await pool.query("SELECT username, resultado FROM auditoria WHERE accion = 'acceso_denegado' AND entidad = 'ruta'");
  assert.ok(aud.some((a) => a.username === 'emp' && a.resultado === 'denegado'));
  // Cualquiera puede ver el estado.
  assert.equal((await api('GET', '/api/funciones', { token: empleado })).status, 200);
});

test('Usuarios.RN77/EX15: activar con su requisito es todo o nada, y cada cambio confirmado sube la versión de a uno', async () => {
  const v0 = (await estado()).version;
  const solo = await cambiar({ activar: ['STK-SERIE'] });
  assert.equal(solo.status, 400);
  assert.match(solo.json.error, /Requiere: VEN-SERIE/);
  assert.equal((await estado()).version, v0);
  assert.equal(de(await estado(), 'STK-SERIE').activa, false);

  const junto = await cambiar({ activar: ['STK-SERIE', 'VEN-SERIE'] });
  assert.equal(junto.status, 200, JSON.stringify(junto.json));
  assert.equal(junto.json.version, v0 + 1);
  const e = await estado();
  assert.ok(de(e, 'STK-SERIE').activa && de(e, 'VEN-SERIE').activa);
  const [[h]] = await pool.query('SELECT origen, username, cambios FROM version_configuracion WHERE version = ?', [v0 + 1]);
  assert.equal(h.origen, 'pantalla');
  assert.deepEqual(Object.keys(JSON.parse(h.cambios)).sort(), ['STK-SERIE', 'VEN-SERIE']);

  // Sin cambios reales no hay versión nueva.
  assert.equal((await cambiar({ activar: ['VEN-SERIE'] })).json.version, v0 + 1);
});

test('Usuarios.RN28/EX17/EX53: desactivar lo que otras necesitan pide cascada; con datos vigentes no se ofrece', async () => {
  // VEN-SERIE con STK-SERIE activa: bloqueado, sin cascada.
  const v = (await estado()).version;
  const serie = await cambiar({ desactivar: ['VEN-SERIE'], confirmar: { cascada: true } });
  assert.equal(serie.status, 409);
  assert.equal(serie.json.codigo, 'DATOS_VIGENTES');
  assert.deepEqual(serie.json.dependientes, ['STK-SERIE']);
  assert.equal((await estado()).version, v);
  // Primero la dependiente, y después sí.
  assert.equal((await cambiar({ desactivar: ['STK-SERIE'] })).status, 200);
  assert.equal((await cambiar({ desactivar: ['VEN-SERIE'] })).status, 200);

  // Cascada común: STK-TRAZA necesita STK-LOTES (sanitarias: se prueban sin autorización a propósito más abajo).
  await pool.query("UPDATE parametros SET valor = '0' WHERE clave = 'autorizacion_admin_funciones_sanitarias'");
  const v2 = (await estado()).version;
  const sinConfirmar = await cambiar({ desactivar: ['STK-LOTES'], motivo: 'prueba' });
  assert.equal(sinConfirmar.status, 409);
  assert.deepEqual(sinConfirmar.json.cascada, ['STK-TRAZA']);
  assert.equal((await estado()).version, v2); // EX17: no se tocó nada
  const conf = await cambiar({ desactivar: ['STK-LOTES'], confirmar: { cascada: true }, motivo: 'prueba' });
  assert.equal(conf.status, 200);
  assert.equal(conf.json.version, v2 + 1); // una sola versión para el conjunto
  const e = await estado();
  assert.ok(!de(e, 'STK-LOTES').activa && !de(e, 'STK-TRAZA').activa);
  // Reactivar con su requisito en el mismo cambio.
  assert.equal((await cambiar({ activar: ['STK-LOTES', 'STK-TRAZA'] })).status, 200);
  await pool.query("UPDATE parametros SET valor = '1' WHERE clave = 'autorizacion_admin_funciones_sanitarias'");
});

test('Usuarios.RN27/EX16: con operaciones pendientes avisa, las lista y exige confirmar', async () => {
  await cambiar({ activar: ['VEN-FRANJA'] });
  Funciones.registrarComprobacion('VEN-FRANJA', { pendientes: async () => ['pedido 41 abierto'] });
  const r = await cambiar({ desactivar: ['VEN-FRANJA'] });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.pendientes, ['VEN-FRANJA: pedido 41 abierto']);
  assert.ok(de(await estado(), 'VEN-FRANJA').activa);
  assert.equal((await cambiar({ desactivar: ['VEN-FRANJA'], confirmar: { pendientes: true } })).status, 200);
  Funciones.registrarComprobacion('VEN-FRANJA', {});
});

test('Usuarios.RN86: desactivar una función sanitaria exige motivo y la credencial de OTRO Administrador, y avisa en la auditoría', async () => {
  const sin = await cambiar({ desactivar: ['STK-ALERGENOS'] });
  assert.equal(sin.status, 400);
  assert.equal(sin.json.codigo, 'MOTIVO_REQUERIDO');
  const sinAut = await cambiar({ desactivar: ['STK-ALERGENOS'], motivo: 'no usamos recetas' });
  assert.equal(sinAut.status, 403);
  assert.equal(sinAut.json.codigo, 'REQUIERE_AUTORIZACION_SANITARIA');
  // La credencial del mismo Administrador no sirve.
  const propia = await cambiar({ desactivar: ['STK-ALERGENOS'], motivo: 'no usamos recetas', autorizacion: { credencial: '1111' } });
  assert.equal(propia.status, 403);
  assert.equal(propia.json.codigo, 'AUTORIZACION_INVALIDA');
  assert.ok(de(await estado(), 'STK-ALERGENOS').activa);

  const ok = await cambiar({ desactivar: ['STK-ALERGENOS'], motivo: 'no usamos recetas', autorizacion: { credencial: '2222' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const [[ev]] = await pool.query("SELECT detalle, username FROM auditoria WHERE modulo = 'funciones' AND accion = 'cambiar' ORDER BY id DESC LIMIT 1");
  assert.match(ev.detalle, /no usamos recetas/);
  assert.match(ev.detalle, /autorizó jefa/);
  await cambiar({ activar: ['STK-ALERGENOS'] });
});

test('Usuarios.RN75: un pedido abierto sigue con las funciones con que se abrió', async () => {
  await pool.query('INSERT INTO mesas (numero_mesa) VALUES (7)');
  const [[{ id: mesa }]] = await pool.query('SELECT id FROM mesas LIMIT 1');
  const Pedido = require('../src/models/pedidoModel');
  const abierto = await Pedido.create(mesa);
  assert.ok(JSON.parse(abierto.config_instantanea).includes('VEN-MODIF'));

  await cambiar({ desactivar: ['VEN-MODIF'] });
  const releido = (await pool.query('SELECT config_version, config_instantanea FROM pedidos WHERE id = ?', [abierto.id]))[0][0];
  assert.ok(JSON.parse(releido.config_instantanea).includes('VEN-MODIF')); // sigue con lo que tenía
  const nuevo = await Pedido.create(mesa);
  assert.ok(!JSON.parse(nuevo.config_instantanea).includes('VEN-MODIF')); // el nuevo usa el estado nuevo
  assert.ok(nuevo.config_version > abierto.config_version);
  await cambiar({ activar: ['VEN-MODIF'] });
});

test('Usuarios.RN29: un perfil pre-carga valores en una sola versión y no toca usuarios ni roles', async () => {
  const [[antes]] = await pool.query('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM roles) r, (SELECT COUNT(*) FROM usuario_roles) ur');
  const v = (await estado()).version;
  const r = await api('POST', '/api/funciones/perfil', { token: admin, body: { perfil: 'produccion_alimentos' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, v + 1);
  const e = await estado();
  assert.equal(de(e, 'VEN-SALON').deseada, false);
  assert.equal(de(e, 'VEN-CC').deseada, true);
  assert.equal(de(e, 'VEN-CC').activa, false); // Clientes y CC no está instalado: queda deshabilitada y conserva el valor (RN32)
  const [[despues]] = await pool.query('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM roles) r, (SELECT COUNT(*) FROM usuario_roles) ur');
  assert.deepEqual(despues, antes);
  assert.equal((await api('POST', '/api/funciones/perfil', { token: admin, body: { perfil: 'inventado' } })).status, 400);
  assert.deepEqual(Object.keys(PERFILES).sort(), ['cafeteria', 'cafeteria_produccion_propia', 'personalizado', 'produccion_alimentos']);
  await api('POST', '/api/funciones/perfil', { token: admin, body: { perfil: 'cafeteria' } });
});

test('Usuarios.RN78/EX51: durante una restauración no se puede cambiar nada y el intento queda registrado', async () => {
  await pool.query("UPDATE parametros SET valor = '1' WHERE clave = 'restauracion_en_curso'");
  const v = (await estado()).version;
  const r = await cambiar({ activar: ['VEN-KDS'] });
  assert.equal(r.status, 423);
  assert.equal(r.json.codigo, 'RESTAURACION');
  assert.equal((await estado()).version, v);
  const [aud] = await pool.query("SELECT detalle FROM auditoria WHERE accion = 'cambio_rechazado' AND resultado = 'denegado'");
  assert.ok(aud.some((a) => /restauración/.test(a.detalle)));
  await pool.query("UPDATE parametros SET valor = '0' WHERE clave = 'restauracion_en_curso'");
});

test('Usuarios.EX18: si falla al guardar, se revierte todo y queda la misma versión', async () => {
  const antes = await estado();
  await pool.query('RENAME TABLE version_configuracion TO version_configuracion_x');
  const r = await cambiar({ activar: ['VEN-KDS', 'VEN-MOVIL'] });
  await pool.query('RENAME TABLE version_configuracion_x TO version_configuracion');
  assert.equal(r.status, 500);
  const despues = await estado();
  assert.equal(despues.version, antes.version);
  assert.equal(de(despues, 'VEN-KDS').activa, false);
  assert.equal(de(despues, 'VEN-MOVIL').activa, false);
});

test('Usuarios.EX30: instalar un módulo que dejaría una función activa sin su requisito condicional no se completa', async () => {
  assert.equal((await cambiar({ activar: ['VEN-DIVISA'] })).status, 200); // sin Financiero el requisito no rige
  const conflictos = await Funciones.conflictosAlInstalar('financiero');
  assert.equal(conflictos.length, 1);
  assert.match(conflictos[0], /VEN-DIVISA: Requiere: FIN-MONEDA-EXT/);
  await cambiar({ desactivar: ['VEN-DIVISA'] });
  assert.deepEqual(await Funciones.conflictosAlInstalar('financiero'), []);
});

test('Usuarios.RN46: cada respuesta lleva la versión de configuración vigente para que las terminales la tomen', async () => {
  const v = (await estado()).version;
  const r = await api('GET', '/api/funciones', { token: admin });
  assert.equal(r.headers.get('x-config-version'), String(v));
});

test('Usuarios.RF18: un módulo desinstalado deshabilita sus funciones y conserva su valor; reinstalarlo las recupera y sube la versión', async () => {
  const v = (await estado()).version;
  assert.equal((await api('POST', '/api/modulos/stock/desinstalar', { token: admin })).status, 200);
  let e = await estado();
  assert.equal(de(e, 'STK-LOTES').deshabilitada, true);
  assert.equal(de(e, 'STK-LOTES').deseada, true);
  assert.equal(e.version, v + 1);
  assert.equal((await api('POST', '/api/modulos/stock/instalar', { token: admin })).status, 200);
  e = await estado();
  assert.equal(de(e, 'STK-LOTES').activa, true);
  assert.equal(e.version, v + 2);
  const [[h]] = await pool.query('SELECT origen FROM version_configuracion WHERE version = ?', [v + 2]);
  assert.equal(h.origen, 'modulo');
});
