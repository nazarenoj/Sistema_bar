const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { ulid } = require('../src/utils/idGlobal');

let api, pool, cerrar;
before(async () => { ({ api, pool, cerrar } = await iniciarApp({ alta: false })); });
after(async () => { await cerrar(); });

test('Usuarios.RN81: el ULID tiene 26 caracteres, nunca se repite y ordena por creación aunque sea el mismo milisegundo', () => {
  const ids = Array.from({ length: 20000 }, () => ulid());
  assert.ok(ids.every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i)));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
});

test('Usuarios.RN81: la hora del ULID es la del servidor y el reloj que declara el cliente no se usa', async () => {
  const antes = Date.now();
  const id = ulid();
  const ms = [...id.slice(0, 10)].reduce((n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c), 0);
  assert.ok(ms >= antes && ms <= Date.now() + 1);
});

test('Usuarios.RN81: cada pedido nace con ID_Global <CODIGO>-<ULID> único; sin alta de la instancia no se crea documento', async () => {
  const Pedido = require('../src/models/pedidoModel');
  await assert.rejects(() => Pedido.create(1), /no está dada de alta/);

  await pool.query("INSERT INTO configuracion_instancia (id, codigo_instancia, razon_social, sucursal) VALUES (1, 'CHP01', 'X', 'Y')");
  await pool.query('INSERT INTO mesas (numero_mesa) VALUES (1)');
  const [[{ id: mesa }]] = await pool.query('SELECT id FROM mesas LIMIT 1');
  const a = await Pedido.create(mesa);
  const b = await Pedido.create(mesa);
  assert.match(a.id_global, /^CHP01-[0-9A-Z]{26}$/);
  assert.notEqual(a.id_global, b.id_global);
  await assert.rejects(() => pool.query('UPDATE pedidos SET id_global = ? WHERE id = ?', [a.id_global, b.id]), /Duplicate/);
});
