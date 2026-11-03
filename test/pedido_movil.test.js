const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, mozo1, mozo2, encargado, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol, terminal) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1', ...(terminal && { terminal }) } })).json.token;
  };
  await pool.query("INSERT INTO terminales (nombre, codigo, tipo) VALUES ('Tablet 1', 'MOV00001', 'dispositivo_movil'), ('Tablet 2', 'MOV00002', 'dispositivo_movil')");
  token = await usuario('adm', 'administrador');
  mozo1 = await usuario('mario', 'mozo', 'MOV00001');
  mozo2 = await usuario('marta', 'mozo', 'MOV00002');
  encargado = await usuario('enzo', 'encargado');
});
after(async () => { await cerrar(); });

const producto = async (nombre) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio: 100 } })).json;
const op = (t, tipo, extra = {}, id = `op-${++k}-${Math.random().toString(36).slice(2, 8)}`) => api('POST', '/api/movil/operaciones', { token: t, body: { id_operacion: id, tipo, ...extra } });
const nuevaMesa = async () => (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
// Un pedido abierto por la tablet 1 con un ítem; devuelve { pedido_id, item }.
const conItem = async (p) => {
  const mesa = await nuevaMesa();
  const a = await op(mozo1, 'abrir_pedido', { datos: { mesa_id: mesa.id } });
  assert.equal(a.json.estado, 'aplicada', JSON.stringify(a.json));
  const r = await op(mozo1, 'agregar_item', { pedido_id: a.json.pedido_id, datos: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
  assert.equal(r.json.estado, 'aplicada', JSON.stringify(r.json));
  const [item] = (await pool.query('SELECT id, version FROM pedido_productos WHERE pedido_id = ?', [a.json.pedido_id]))[0];
  return { mesa, pedido_id: a.json.pedido_id, item };
};

test('Ventas.RF39: sin VEN-MOVIL no hay dispositivo; el equipo debe estar registrado como dispositivo móvil', async () => {
  assert.equal((await op(mozo1, 'abrir_pedido')).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-MOVIL'], motivo: 'prueba' } })).status, 200);
  assert.equal((await op(encargado, 'abrir_pedido', { datos: {} })).status, 403); // sesión sin dispositivo móvil
  assert.equal((await op(mozo1, 'rara', {})).status, 400);
  assert.equal((await api('POST', '/api/movil/operaciones', { token: mozo1, body: { tipo: 'abrir_pedido' } })).status, 400); // sin id_operacion
  assert.equal((await op(mozo1, 'abrir_pedido', { id_dispositivo: 'OTRO0001', datos: {} })).status, 400);
});

test('Ventas.RN64/RN66: cada operación es idempotente por su ID_Operacion y se puede consultar su estado', async () => {
  const mesa = await nuevaMesa();
  const cuerpo = { datos: { mesa_id: mesa.id } };
  const a = await op(mozo1, 'abrir_pedido', cuerpo, 'abrir-idem-0001');
  assert.equal(a.json.estado, 'aplicada', JSON.stringify(a.json));
  const b = await op(mozo1, 'abrir_pedido', cuerpo, 'abrir-idem-0001');
  assert.deepEqual([b.json.repetida, b.json.pedido_id], [true, a.json.pedido_id]);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM pedidos WHERE mesa_id = ?', [mesa.id]))[0][0].n, 1); // no abrió dos
  const otro = await op(mozo1, 'abrir_pedido', { datos: { mesa_id: mesa.id, referencia: 'distinto' } }, 'abrir-idem-0001');
  assert.equal(otro.status, 409);
  assert.equal((await api('GET', '/api/movil/operaciones/abrir-idem-0001', { token: mozo1 })).json.estado, 'aplicada');
  assert.equal((await api('GET', '/api/movil/operaciones/nunca-llego-1', { token: mozo1 })).json.estado, 'desconocida');
});

test('Ventas.RN37: agregar suma lo de ambos dispositivos; modificar y anular exigen la versión base del ítem', async () => {
  const cafe = await producto('Café');
  const { pedido_id, item } = await conItem(cafe);
  // El otro dispositivo agrega al mismo pedido: se suman, no se pisan.
  const dos = await op(mozo2, 'agregar_item', { pedido_id, datos: { productos: [{ producto_id: cafe.id, cantidad: 2 }] } });
  assert.equal(dos.json.estado, 'aplicada', JSON.stringify(dos.json));
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM pedido_productos WHERE pedido_id = ?', [pedido_id]))[0][0].n, 2);
  // Modificar con la versión que vio.
  const m = await op(mozo1, 'modificar_item', { pedido_id, item_id: item.id, version_item: item.version, datos: { cantidad: 3 } });
  assert.equal(m.json.estado, 'aplicada', JSON.stringify(m.json));
  assert.equal(m.json.version_item, item.version + 1);
  // Con la versión vieja se rechaza, con el estado actual, y no "gana el último".
  const viejo = await op(mozo2, 'modificar_item', { pedido_id, item_id: item.id, version_item: item.version, datos: { cantidad: 9 } });
  assert.equal(viejo.json.estado, 'rechazada');
  assert.equal(viejo.json.estado_actual.version_item, item.version + 1);
  assert.equal(Number((await pool.query('SELECT cantidad FROM pedido_productos WHERE id = ?', [item.id]))[0][0].cantidad), 3);
  // Un cambio hecho desde la terminal (no desde un dispositivo) también sube la versión.
  await api('PATCH', `/api/pedidos/${pedido_id}/productos/${item.id}/entregado`, { token, body: { entregado: true } });
  const web = await op(mozo1, 'anular_item', { pedido_id, item_id: item.id, version_item: item.version + 1 });
  assert.equal(web.json.estado, 'rechazada');
  const actual = (await pool.query('SELECT version FROM pedido_productos WHERE id = ?', [item.id]))[0][0].version;
  const ok = await op(mozo1, 'anular_item', { pedido_id, item_id: item.id, version_item: actual, datos: { motivo: 'se equivocó' } });
  assert.equal(ok.json.estado, 'aplicada', JSON.stringify(ok.json));
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM pedido_productos WHERE id = ?', [item.id]))[0][0].n, 0);
  assert.equal((await op(mozo1, 'modificar_item', { pedido_id, item_id: item.id, version_item: actual })).json.estado, 'rechazada'); // ya no existe
  assert.equal((await op(mozo1, 'modificar_item', { pedido_id, item_id: 1 })).status, 400); // falta la versión base
});

test('Ventas.RN37: enviar la comanda es idempotente entre dispositivos y un ítem enviado ya no se modifica', async () => {
  const cafe = await producto('Café');
  const { mesa, pedido_id, item } = await conItem(cafe);
  const e1 = await op(mozo1, 'enviar_comanda', { pedido_id });
  assert.deepEqual([e1.json.estado, e1.json.ya_enviado], ['aplicada', false]);
  const e2 = await op(mozo2, 'enviar_comanda', { pedido_id });
  assert.deepEqual([e2.json.estado, e2.json.ya_enviado], ['aplicada', true]); // "ya enviado": no se duplica
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM comandas WHERE mesa_id = ?', [mesa.id]))[0][0].n, 1);
  const tarde = await op(mozo2, 'modificar_item', { pedido_id, item_id: item.id, version_item: item.version, datos: { cantidad: 5 } });
  assert.equal(tarde.json.estado, 'rechazada');
  assert.match(tarde.json.motivo, /ya se envió/);
});

test('Ventas.EX50/RN66: sobre un pedido cerrado o movido se rechaza con el estado actual y queda en los conflictos de sincronización', async () => {
  const cafe = await producto('Café');
  const { mesa, pedido_id } = await conItem(cafe);
  const destino = await nuevaMesa();
  const mv = await op(mozo2, 'mover_mesa', { pedido_id, datos: { mesa_id: destino.id } });
  assert.equal(mv.json.estado, 'aplicada', JSON.stringify(mv.json));
  assert.equal((await op(mozo1, 'cobrar', { pedido_id, datos: { metodo_pago: 'efectivo' } })).json.estado, 'rechazada'); // cobro no habilitado en el dispositivo
  const cierre = await api('POST', `/api/pedidos/${pedido_id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-mov-${++k}-abcdef` } });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.json));
  const tarde = await op(mozo1, 'agregar_item', { pedido_id, datos: { productos: [{ producto_id: cafe.id, cantidad: 1 }] } });
  assert.equal(tarde.json.estado, 'rechazada');
  assert.equal(tarde.json.estado_actual.estado, 'finalizado');
  assert.match(tarde.json.motivo, /cobrado o cerrado/);
  assert.equal((await op(mozo1, 'enviar_comanda', { pedido_id })).json.estado, 'rechazada');
  // El mozo ve sus conflictos; el encargado, los de todos; todo queda auditado.
  const propios = (await api('GET', '/api/movil/conflictos', { token: mozo1 })).json;
  assert.ok(propios.length >= 2 && propios.every((c) => c.username === 'mario'));
  assert.equal((await api('GET', '/api/movil/conflictos', { token: mozo2 })).json.every((c) => c.username === 'marta'), true);
  assert.ok((await api('GET', '/api/movil/conflictos', { token: encargado })).json.some((c) => c.username === 'mario'));
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'movil_conflicto'"))[0][0].n >= 3);
  // Un pedido que ya no existe (anulado) también se rechaza.
  const { pedido_id: p2 } = await conItem(cafe);
  await pool.query('DELETE FROM pedido_productos WHERE pedido_id = ?', [p2]);
  await pool.query('DELETE FROM pedidos WHERE id = ?', [p2]);
  const anulado = await op(mozo1, 'agregar_item', { pedido_id: p2, datos: { productos: [{ producto_id: cafe.id, cantidad: 1 }] } });
  assert.equal(anulado.json.estado_actual.estado, 'anulado');
});

test('Ventas.EX26: un dispositivo que vuelve tras más de 2 minutos sin conexión avisa al supervisor', async () => {
  assert.equal((await api('POST', '/api/movil/latido', { token: mozo1 })).json.estuvo_sin_conexion, false);
  assert.equal((await api('POST', '/api/movil/latido', { token: mozo1 })).json.estuvo_sin_conexion, false);
  await pool.query("UPDATE terminales SET ultimo_contacto = DATE_SUB(NOW(), INTERVAL 5 MINUTE) WHERE codigo = 'MOV00001'");
  assert.equal((await api('POST', '/api/movil/latido', { token: mozo1 })).json.estuvo_sin_conexion, true);
  const [[a]] = await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'dispositivo_sin_conexion'");
  assert.match(a.mensaje, /Tablet 1/);
  assert.equal((await api('POST', '/api/movil/latido', { token: encargado })).status, 403);
});
