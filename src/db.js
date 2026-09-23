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
    appName: process.env.SQL_APPNAME || 'NOIBO-API',
    keepAlive: true,
    keepAliveInitialDelay: Number(process.env.SQL_KEEPALIVE_DELAY || 10000),
  },
};

async function _connectOnce() {
  const pool = await sql.connect(config);
  console.log('✅ Kết nối SQL Server thành công');

  // Chỉ bỏ pool khi nó thật sự hỏng (ECONNRESET, ESOCKET, ECONNCLOSED...).
  // KHÔNG bỏ pool vì một request hết giờ chờ (TimeoutError của tarn): đóng pool
  // lúc đó bắt mọi request sau phải đăng nhập lại, mà đăng nhập là khâu chậm
  // nhất khi server quá tải → hỏng dây chuyền.
  pool.on('error', err => {
    const fatal = !pool.connected
      || ['ECONNRESET', 'ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'ETIMEOUT'].includes(err?.code);
    console.error(`[DB] Pool error (${fatal ? 'bỏ pool, sẽ kết nối lại' : 'bỏ qua, pool vẫn dùng được'}):`, err?.message || err);
    if (!fatal) return;
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


