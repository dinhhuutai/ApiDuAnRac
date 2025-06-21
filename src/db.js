require('dotenv').config();
const fs = require('fs');

const sql = require("mssql");

const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  options: {
    encrypt: process.env.SQL_ENCRYPT === 'true',
    trustServerCertificate: false,
    cryptoCredentialsDetails: {
      ca: fs.readFileSync('./src/global-bundle.pem')
    }
  }
};

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    console.log("✅ Kết nối SQL Server thành công");
    return pool;
  })
  .catch(err => {
    console.error("❌ Lỗi kết nối SQL Server:", err);
    throw err;
  });

module.exports = {
  sql, poolPromise
};
