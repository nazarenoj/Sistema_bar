const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');

let api, pool, cerrar, adm, gerente, latte, budin, te, alerg, grupoLeche, grupoTam;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-nav', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  const prod = async (nombre, precio) => (await api('POST', '/api/productos', { token: adm.token, body: { nombre, precio, stock: 0 } })).json;
  latte = await prod('Latte', 1500); budin = await prod('Budin de limon', 900); te = await prod('Te de hierbas', 700);
  for (const [p, o] of [[latte, 1], [budin, 2], [te, 3]]) await api('PUT', `/api/ventas-online/catalogo/${p.id}`, { token: gerente.token, body: { categoria_online: 'Menu', orden: o } });
  alerg = Object.fromEntries((await pool.query('SELECT id, codigo FROM ven_alergenos'))[0].map((a) => [a.codigo, a.id]));
  const Alergenos = require('../src/services/alergenoVentaService');
  const Mod = require('../src/services/modificadorService');
  await Alergenos.declararArticulo(latte.id, [alerg.lacteos]);
  await Alergenos.declararArticulo(budin.id, [alerg.gluten, alerg.huevo]);
  grupoLeche = await Mod.guardar(null, { nombre: 'Leche', obligatorio: true, minimo: 1, maximo: 1, opciones: [{ nombre: 'Entera', ajuste_precio: 0 }, { nombre: 'De almendras', ajuste_precio: 250 }], aplica_a: [{ producto_id: latte.id }] });
  grupoTam = await Mod.guardar(null, { nombre: 'Extras', obligatorio: false, minimo: 0, maximo: 2, opciones: [{ nombre: 'Shot extra', ajuste_precio: 200 }, { nombre: 'Crema', ajuste_precio: 100 }], aplica_a: [{ producto_id: latte.id }] });
  await Alergenos.declararOpcion(grupoLeche.opciones[1].id, [alerg.frutos_secos ?? alerg.almendras ?? Object.values(alerg).find((id) => ![alerg.lacteos, alerg.gluten, alerg.huevo].includes(id))]);
});
after(async () => { await cerrar(); });

const get = (r) => api('GET', `/tienda/cafe-nav${r}`);

test('Ventas Online.RF22: el listado y la ficha muestran los alergenos del articulo', async () => {
  const l = (await get('/catalogo')).json;
  assert.deepEqual(l.find((x) => x.id === latte.id).alergenos.map((a) => a.codigo), ['lacteos']);
  assert.deepEqual(l.find((x) => x.id === budin.id).alergenos.map((a) => a.codigo).sort(), ['gluten', 'huevo']);
  assert.deepEqual(l.find((x) => x.id === te.id).alergenos, []);
  const d = (await get(`/catalogo/${budin.id}`)).json;
  assert.equal(d.titulo, 'Budin de limon'); assert.equal(d.alergenos.length, 2);
  assert.equal((await get('/catalogo/99999')).status, 404);
});

test('Ventas Online.RF05: se busca por nombre y se excluyen articulos con ciertos alergenos', async () => {
  assert.deepEqual((await get('/catalogo?sin_alergenos=gluten')).json.map((x) => x.id).sort(), [latte.id, te.id].sort());
  assert.deepEqual((await get('/catalogo?sin_alergenos=gluten,lacteos')).json.map((x) => x.id), [te.id]);
  assert.deepEqual((await get('/catalogo?q=limon')).json.map((x) => x.id), [budin.id]);
  assert.deepEqual((await get('/catalogo?categoria=Menu&orden=-precio')).json.map((x) => x.id), [latte.id, budin.id, te.id]);
});

test('Ventas Online.RF22/RN33: la ficha trae los grupos de opciones con su ajuste y los alergenos que suma cada opcion', async () => {
  const d = (await get(`/catalogo/${latte.id}`)).json;
  assert.deepEqual(d.grupos.map((g) => [g.nombre, g.obligatorio, g.maximo]), [['Leche', true, 1], ['Extras', false, 2]]);
  const leche = d.grupos[0];
  assert.equal(leche.opciones[1].ajuste_precio, 250);
  assert.equal(leche.opciones[0].alergenos.length, 0);
  assert.equal(leche.opciones[1].alergenos.length, 1); // la opcion de almendras suma un alergeno propio
});

test('Ventas Online.EX23: un grupo obligatorio incompleto impide agregar el articulo y la eleccion calcula precio y alergenos', async () => {
  const sel = (id, opciones) => api('POST', `/tienda/cafe-nav/catalogo/${id}/seleccion`, { body: { opciones } });
  const sin = await sel(latte.id, []);
  assert.equal(sin.status, 400); assert.equal(sin.json.codigo, 'GRUPO_INCOMPLETO'); assert.equal(sin.json.grupo, 'Leche');
  assert.equal((await sel(latte.id, [grupoLeche.opciones[0].id, grupoLeche.opciones[1].id])).json.codigo, 'OPCION_INVALIDA'); // maximo 1 en Leche
  assert.equal((await sel(latte.id, [999999])).json.codigo, 'OPCION_INVALIDA');
  assert.equal((await sel(te.id, [grupoLeche.opciones[0].id])).json.codigo, 'OPCION_INVALIDA'); // la opcion no se aplica a este articulo
  assert.equal((await sel(99999, [])).status, 404);
  const ok = await sel(latte.id, [grupoLeche.opciones[1].id, grupoTam.opciones[0].id]);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.precio_unitario, 1500 + 250 + 200); assert.equal(ok.json.ajuste, 450);
  assert.deepEqual(ok.json.alergenos.map((a) => a.codigo).includes('lacteos'), true);
  assert.equal(ok.json.alergenos.length, 2); // lacteos del articulo + el de la opcion
  assert.equal((await sel(te.id, [])).json.precio_unitario, 700);
});

test('Ventas Online.RN33: sin VEN-MODIF la tienda no muestra grupos de opciones', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { desactivar: ['VEN-MODIF'], motivo: 'prueba' } });
  const d = (await get(`/catalogo/${latte.id}`)).json;
  assert.deepEqual(d.grupos, []);
  assert.equal((await api('POST', `/tienda/cafe-nav/catalogo/${latte.id}/seleccion`, { body: { opciones: [] } })).status, 200);
});
