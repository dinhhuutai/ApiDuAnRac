const sql = require("mssql/msnodesqlv8");

const config = {
  connectionString: "Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=DuAnRac;Trusted_Connection=Yes;TrustServerCertificate=Yes;"
};


const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    console.log("✅ Kết nối SQL Server thành công (Windows Auth)");
    return pool;
  })
  .catch(err => {
    console.error("❌ Lỗi kết nối SQL Server:", err);
    throw err;
  });

module.exports = {
  sql, poolPromise
};
