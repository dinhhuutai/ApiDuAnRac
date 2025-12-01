// require('dotenv').config();
// const fs = require('fs');

// const sql = require("mssql");

// const config = {
//   user: process.env.SQL_USER,
//   password: process.env.SQL_PASSWORD,
//   server: process.env.SQL_SERVER,
//   database: process.env.SQL_DATABASE,
//   options: {
//     encrypt: process.env.SQL_ENCRYPT === 'true',
//     trustServerCertificate: true,
//   },
//   requestTimeout: 120000
// };

// const poolPromise = new sql.ConnectionPool(config)
//   .connect()
//   .then(pool => {
//     console.log("✅ Kết nối SQL Server thành công");
//     return pool;
//   })
//   .catch(err => {
//     console.error("❌ Lỗi kết nối SQL Server:", err);
//     throw err;
//   });

// module.exports = {
//   sql, poolPromise
// };


// db.js
require('dotenv').config();
const sql = require('mssql');

let _pool = null;        // pool hiện tại
let _connecting = null;  // promise đang connect (tránh connect song song)

const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  port: Number(process.env.SQL_PORT || 1433),

  pool: {
    max: Number(process.env.SQL_POOL_MAX || 10),
    min: Number(process.env.SQL_POOL_MIN || 1),
    idleTimeoutMillis: Number(process.env.SQL_POOL_IDLE || 30000),
    acquireTimeoutMillis: Number(process.env.SQL_POOL_ACQUIRE || 15000),
  },

  requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT || 30000),
  connectionTimeout: Number(process.env.SQL_CONNECTION_TIMEOUT || 15000),

  options: {
    encrypt: process.env.SQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    enableArithAbort: true,
    appName: process.env.SQL_APPNAME || 'ApiDuAnRac',
    keepAlive: true,
    keepAliveInitialDelay: Number(process.env.SQL_KEEPALIVE_DELAY || 10000),
  },
};

async function _connectOnce() {
  const pool = await sql.connect(config);
  console.log('✅ Kết nối SQL Server thành công');

  // Nếu pool có lỗi (ECONNRESET, ESOCKET, ...), bỏ pool để lần sau tạo lại
  pool.on('error', err => {
    console.error('[DB] Pool error:', err);
    try { pool.close(); } catch {}
    _pool = null;
    _connecting = null;
  });

  return pool;
}

async function getPool() {
  // Đã có pool và đang connected -> dùng lại
  if (_pool && _pool.connected) return _pool;

  // Đã có một kết nối đang diễn ra -> chờ nó
  if (_connecting) return _connecting;

  // Tạo kết nối mới
  _connecting = _connectOnce()
    .then(pool => {
      _pool = pool;
      _connecting = null;
      return _pool;
    })
    .catch(err => {
      _pool = null;
      _connecting = null;
      console.error('❌ Lỗi kết nối SQL Server:', err);
      throw err;
    });

  return _connecting;
}

/**
 * thenable: Giúp giữ nguyên cách dùng cũ `await poolPromise`
 * nhưng mỗi lần await sẽ luôn gọi getPool() (pool tự phục hồi).
 */
const poolPromise = {
  then: (resolve, reject) => getPool().then(resolve, reject),
  // Cho phép .catch/.finally nếu ai đó dùng
  catch: (reject) => getPool().catch(reject),
  finally: (onFinally) => getPool().finally(onFinally),
};

process.on('SIGINT', async () => {
  try { if (_pool) await _pool.close(); } catch {}
  process.exit(0);
});

module.exports = { sql, poolPromise };
