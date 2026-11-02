const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, tokenMozo, barra, n = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  tokenMozo = await usuario('mario', 'mozo');
  barra = (await api('POST', '/api/sectores', { token, body: { nombre: 'Barra' } })).json;
});
after(async () => { await cerrar(); });

const producto = async (nombre, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio: 100, ...extra } })).json;
const nuevoPedido = async (t = token) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  return { mesa, pedido: (await api('POST', '/api/pedidos', { token: t, body: { mesa_id: mesa.id } })).json };
};
const agregar = (pedido, p, t = token) => api('POST', `/api/pedidos/${pedido.id}/productos`, { token: t, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
const enviada = async () => {
  const cafe = await producto('Café', { sector_id: barra.id });
  const { mesa, pedido } = await nuevoPedido();
  await agregar(pedido, cafe);
  const r = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.comandas[0];
};
const pantalla = async (q = '') => (await api('GET', `/api/cocina/comandas${q}`, { token })).json;

test('Ventas.RF38: sin VEN-KDS no hay pantalla; con ella la comanda aparece aunque no esté impresa', async () => {
  assert.equal((await api('GET', '/api/cocina/comandas', { token })).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-KDS'], motivo: 'prueba' } })).status, 200);
  const c = await enviada();
  assert.equal(c.impresa_at, null);
  const lista = await pantalla(`?sector_id=${barra.id}`);
  const en = lista.find((x) => x.id === c.id);
  assert.deepEqual([en.avance, en.demorada, en.minutos], ['pendiente', false, 0]);
  await api('POST', `/api/comandas/${c.id}/impresa`, { token }).catch(() => {});
  assert.equal((await pantalla()).filter((x) => x.id === c.id).length, 1); // sin duplicarse, impresa o no
});

test('Ventas.RN35: los estados avanzan en orden con la hora de cada cambio; retroceder exige permiso y motivo y queda registrado', async () => {
  const c = await enviada();
  const av = (id = c.id, t = token) => api('POST', `/api/cocina/comandas/${id}/avanzar`, { token: t });
  assert.equal((await av()).json.hasta, 'en_preparacion');
  assert.equal((await av()).json.hasta, 'listo');
  const listo = (await pantalla('?avance=listo')).find((x) => x.id === c.id);
  assert.ok(listo.horas.en_preparacion && listo.horas.listo);
  assert.equal((await av()).json.hasta, 'entregado');
  assert.equal((await av()).status, 409);
  assert.equal((await pantalla()).some((x) => x.id === c.id), false); // entregada: sale de la pantalla
  // Retroceder: el barista no tiene el permiso; el encargado/administrador, con motivo.
  const ret = (motivo, t = token) => api('POST', `/api/cocina/comandas/${c.id}/retroceder`, { token: t, body: { motivo } });
  assert.equal((await ret('se cayó', tokenBarista)).status, 403);
  assert.equal((await ret('')).status, 400);
  assert.equal((await ret('se cayó al piso')).json.hasta, 'listo');
  const [log] = (await pool.query("SELECT retroceso, motivo FROM comanda_avances WHERE comanda_id = ? AND retroceso = 1", [c.id]))[0];
  assert.deepEqual([log.retroceso, log.motivo], [1, 'se cayó al piso']);
  const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'comanda_retroceso'");
  assert.equal(a.n, 1);
  const t = (await api('GET', '/api/cocina/tiempos', { token })).json.find((x) => x.sector === 'Barra');
  assert.ok(t.comandas >= 1);
  assert.equal((await api('POST', '/api/cocina/comandas/99999/avanzar', { token })).status, 404);
});

test('Ventas.RF38: la demora configurable alerta, y las pantallas caídas se distinguen (EX25)', async () => {
  const c = await enviada();
  assert.equal((await api('PUT', '/api/cocina/configuracion', { token, body: { demora_min: 0 } })).status, 400);
  assert.equal((await api('PUT', '/api/cocina/configuracion', { token, body: { demora_min: 5 } })).json.demora_min, 5);
  await pool.query('UPDATE comandas SET created_at = DATE_SUB(NOW(), INTERVAL 7 MINUTE) WHERE id = ?', [c.id]);
  const d = (await pantalla()).find((x) => x.id === c.id);
  assert.deepEqual([d.demorada, d.minutos >= 7], [true, true]);
  await api('POST', `/api/cocina/comandas/${c.id}/avanzar`, { token });
  await api('POST', `/api/cocina/comandas/${c.id}/avanzar`, { token });
  assert.equal((await pantalla('?avance=listo')).find((x) => x.id === c.id).demorada, false); // lista: ya no corre la demora
  // Pantalla: conectada con latido reciente, caída sin él; la comanda queda en la cola igual.
  const [t] = await pool.query("INSERT INTO terminales (nombre, codigo, tipo) VALUES ('Pantalla barra', 'PAN00001', 'pantalla_cocina')");
  const Cocina = require('../src/services/cocinaService');
  assert.equal((await api('GET', '/api/cocina/pantallas', { token })).json[0].conectada, false);
  await Cocina.latido(t.insertId);
  assert.equal((await api('GET', '/api/cocina/pantallas', { token })).json[0].conectada, true);
  await pool.query('UPDATE terminales SET ultimo_contacto = DATE_SUB(NOW(), INTERVAL 5 MINUTE) WHERE id = ?', [t.insertId]);
  assert.equal((await api('GET', '/api/cocina/pantallas', { token })).json[0].conectada, false);
});

test('Ventas.RN35/EX27: el agotado manual avisa por los pedidos abiertos y bloquea o, en modo advertir, se vende con permiso', async () => {
  const budin = await producto('Budín');
  const { pedido } = await nuevoPedido(tokenMozo);
  assert.equal((await agregar(pedido, budin, tokenMozo)).status, 201); // todavía sin enviar a producción
  assert.equal((await api('PUT', `/api/cocina/agotados/${budin.id}`, { token: tokenBarista, body: { agotado: true } })).status, 403); // el barista no marca agotados
  const m = await api('PUT', `/api/cocina/agotados/${budin.id}`, { token, body: { agotado: true } });
  assert.deepEqual([m.status, m.json.pedidos_avisados], [200, 1]);
  const [[aviso]] = await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'agotado_en_pedido' LIMIT 1");
  assert.match(aviso.mensaje, /ofrecé una alternativa/);
  assert.equal((await api('PUT', `/api/cocina/agotados/${budin.id}`, { token: tokenMozo, body: { agotado: true } })).status, 403); // el mozo no marca agotados
  // Modo bloquear (por defecto): nadie lo vende. Lo ya cargado no se anula.
  const { pedido: otro } = await nuevoPedido();
  assert.equal((await agregar(otro, budin)).status, 409);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM pedido_productos WHERE pedido_id = ?', [pedido.id]))[0][0].n, 1);
  // Modo advertir: con permiso se vende y se advierte; sin él, sigue bloqueado.
  assert.equal((await api('PUT', '/api/cocina/configuracion', { token, body: { agotado_modo: 'raro' } })).status, 400);
  await api('PUT', '/api/cocina/configuracion', { token, body: { agotado_modo: 'advertir' } });
  const v = await agregar(otro, budin);
  assert.equal(v.status, 201, JSON.stringify(v.json));
  assert.match(v.json.advertencias[0], /agotado/);
  const { pedido: delBarista } = await nuevoPedido(tokenBarista);
  assert.equal((await agregar(delBarista, budin, tokenBarista)).status, 409);
  // Lo que marcó Stock también cuenta (RN36) y lo revierte Stock; el manual lo quita un usuario con permiso.
  await pool.query('UPDATE productos SET agotado = 0, agotado_auto = 1 WHERE id = ?', [budin.id]);
  const auto = await agregar(delBarista, budin, tokenBarista);
  assert.equal(auto.status, 201); // la marca de Stock avisa y no bloquea (RN01)
  assert.match(auto.json.advertencias[0], /sin existencias/);
  await pool.query('UPDATE productos SET agotado_auto = 0 WHERE id = ?', [budin.id]);
  await api('PUT', `/api/cocina/agotados/${budin.id}`, { token, body: { agotado: true } });
  assert.equal((await api('PUT', `/api/cocina/agotados/${budin.id}`, { token, body: { agotado: false } })).json.agotado, false);
  assert.equal((await agregar(otro, budin)).status, 201);
});
