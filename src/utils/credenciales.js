const crypto = require('crypto');

// PIN y código de tarjeta: HMAC-SHA256 con una clave del servidor. A diferencia de bcrypt es
// determinista, así el PIN identifica al usuario sin pedir su nombre y la columna puede ser UNIQUE
// (Usuarios RN02); sigue siendo irreversible sin la clave. Un PIN corto igual se puede adivinar
// probando, por eso los intentos fallidos se frenan (ver throttle.js).
const hashCodigo = (valor) => {
  const clave = process.env.CODIGO_PEPPER || process.env.JWT_SECRET;
  if (!clave) throw new Error('Falta JWT_SECRET (o CODIGO_PEPPER) en el entorno.');
  return crypto.createHmac('sha256', clave).update(String(valor).trim()).digest('hex');
};

module.exports = { hashCodigo };
