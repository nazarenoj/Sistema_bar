// Prueba de arquitectura (A7): compara el código real contra las capas (Índice B.1) y el registro de
// llamadas entre módulos (B.5). No necesita base de datos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MODULOS } = require('../src/modulos/catalogo');
const { LLAMADAS, SERVICIOS_HACIA_ABAJO, FALLAS } = require('../src/modulos/llamadas');
const { validar } = require('../src/modulos/registro');

const SRC = path.join(__dirname, '..', 'src');

const archivos = (dir = SRC) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? archivos(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
const moduloDe = (r) => Object.keys(MODULOS).find((m) => MODULOS[m].archivos.some((re) => re.test(r)));

// Cruces entre módulos que existen hoy y todavía no cumplen las reglas. Solo pueden salir de esta
// lista, nunca entrar. Cada una dice cómo se resuelve.
const DEUDA = {
  // La receta de un producto (insumos que consume) la gestiona hoy el controlador de productos.
  // Se resuelve en la Fase C (Stock): la receta pasa a Stock y Ventas la recibe por el puerto.
  'controllers/productoController.js -> models/insumoModel.js': 'recetas, Fase C',
  'controllers/productoController.js -> models/presentacionModel.js': 'recetas con presentación, se salda en C3',
};

const cruces = () => {
  const out = [];
  for (const f of archivos()) {
    const r = rel(f);
    if (r === 'server.js') continue; // raíz de composición: arma la app con todos los módulos
    const texto = fs.readFileSync(f, 'utf8');
    for (const m of texto.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      let destino = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(destino) || fs.statSync(destino).isDirectory()) destino = fs.existsSync(destino + '.js') ? destino + '.js' : path.join(destino, 'index.js');
      if (!destino.endsWith('.js')) destino += '.js';
      if (!destino.startsWith(SRC)) continue;
      out.push({ desde: r, hacia: rel(destino) });
    }
  }
  return out;
};

test('cada archivo de src/ pertenece a un módulo', () => {
  const sueltos = archivos().map(rel).filter((r) => !moduloDe(r));
  assert.deepEqual(sueltos, [], 'Falta asignarlos en src/modulos/catalogo.js');
});

test('Índice B.1: ningún módulo llama hacia arriba, entre pares de una capa, ni a un módulo de abajo fuera de lo registrado', () => {
  const servicio = (abajo, arriba) => SERVICIOS_HACIA_ABAJO.some((s) => s.expone === abajo && s.llaman.includes(arriba));
  const llamadaB5 = (abajo, arriba) => LLAMADAS.some((l) => l.callee === abajo && (l.caller.includes(arriba) || l.caller.includes('*')));
  const malos = [];
  const usadas = new Set();
  for (const { desde, hacia } of cruces()) {
    const a = moduloDe(desde), b = moduloDe(hacia);
    if (!a || !b || a === b) continue;
    const ca = MODULOS[a].capa, cb = MODULOS[b].capa;
    const clave = `${desde} -> ${hacia}`;
    if (b === 'usuarios' && ca > 0) continue; // plataforma N0: la usan todos hacia abajo (Usuarios RF26)
    if (cb < ca && (servicio(b, a) || llamadaB5(b, a))) continue; // inferior y registrado
    if (DEUDA[clave]) { usadas.add(clave); continue; }
    malos.push(`${clave}  (${a} N${ca} → ${b} N${cb})`);
  }
  assert.deepEqual(malos, []);
  const resueltas = Object.keys(DEUDA).filter((k) => !usadas.has(k));
  assert.deepEqual(resueltas, [], 'Ya no hacen falta: sacalas de DEUDA');
});

test('Índice B.5: el registro está completo y es coherente', () => {
  assert.equal(LLAMADAS.length, 21);
  assert.deepEqual(LLAMADAS.map((l) => l.n), Array.from({ length: 21 }, (_, i) => i + 1));
  for (const l of LLAMADAS) {
    assert.ok(FALLAS.includes(l.falla), `llamada ${l.n}`);
    assert.ok(l.esperaMs > 0, `llamada ${l.n}`);
    for (const c of l.caller) assert.ok(c === '*' || MODULOS[c], `llamada ${l.n}: llama ${c}`);
    assert.ok(['*', 'arca'].includes(l.callee) || MODULOS[l.callee], `llamada ${l.n}: destino ${l.callee}`);
  }
});

test('Índice B.5: toda llamada() del código figura en el registro y la hace un módulo autorizado', () => {
  const encontradas = [];
  for (const f of archivos()) {
    const r = rel(f);
    if (r.startsWith('modulos/')) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bllamar\(\s*(\d+)\s*,\s*['"]([a-z_]+)['"]/g)) encontradas.push({ r, n: Number(m[1]), quien: m[2] });
  }
  for (const { r, n, quien } of encontradas) {
    const l = LLAMADAS.find((x) => x.n === n);
    assert.ok(l, `${r}: la llamada ${n} no figura en B.5`);
    assert.ok(l.caller.includes('*') || l.caller.includes(quien), `${r}: ${quien} no puede hacer la llamada ${n}`);
    assert.equal(moduloDe(r), quien, `${r}: dice ser ${quien} pero es del módulo ${moduloDe(r)}`);
  }
});

test('una instalación con ciclo o con una llamada hacia arriba se rechaza', () => {
  const base = { a: { capa: 0, dependeDe: [] }, b: { capa: 1, dependeDe: ['a'] } };
  assert.deepEqual(validar(base, ['a', 'b']), []);
  assert.match(validar({ ...base, a: { capa: 0, dependeDe: ['b'] } }, ['a', 'b']).join(' '), /hacia arriba/);
  assert.match(validar({ ...base, c: { capa: 1, dependeDe: ['b'] } }, ['a', 'b', 'c']).join(' '), /misma capa/);
  const ciclo = { x: { capa: 1, dependeDe: ['y'] }, y: { capa: 2, dependeDe: ['x'] } };
  assert.match(validar(ciclo, ['x', 'y']).join(' '), /Ciclo|hacia arriba/);
  assert.match(validar(base, ['b']).join(' '), /necesita que esté instalado a/);
});
