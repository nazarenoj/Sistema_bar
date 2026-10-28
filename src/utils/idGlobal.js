const crypto = require('crypto');
const Instancia = require('../models/instanciaModel');

// ID_Global = <CODIGO_INSTANCIA>-<ULID> (Usuarios RN81). ULID: 48 bits de milisegundos con la hora
// del servidor (RN21) + 80 bits al azar, en base 32 de Crockford (26 caracteres). Ordena por fecha;
// dentro del mismo milisegundo se suma 1 al azar para que siga ordenando. La unicidad sale de la
// hora y el azar, no de un contador que pueda volver atrás tras restaurar una copia.
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_ALEATORIO = (1n << 80n) - 1n;

let ultimoMs = -1;
let ultimoAzar = 0n;

const codificar = (valor, largo) => {
  let s = '';
  for (let i = 0; i < largo; i++) { s = ALFABETO[Number(valor & 31n)] + s; valor >>= 5n; }
  return s;
};

const ulid = (ahora = Date.now()) => {
  if (ahora <= ultimoMs && ultimoAzar < MAX_ALEATORIO) {
    ultimoAzar += 1n;
    ahora = ultimoMs;
  } else {
    ultimoAzar = BigInt('0x' + crypto.randomBytes(10).toString('hex'));
    ultimoMs = Math.max(ahora, ultimoMs);
  }
  return codificar(BigInt(ultimoMs), 10) + codificar(ultimoAzar, 16);
};

const idGlobal = async () => `${await Instancia.codigo()}-${ulid()}`;

module.exports = { idGlobal, ulid };
