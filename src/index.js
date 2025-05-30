require('dotenv').config();
const express = require("express");
const { sql, poolPromise } = require("./db");
const bcrypt = require("bcrypt");

const cors = require("cors");
const jwt = require("jsonwebtoken");
const SECRET = "Tai31072002@";

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());

app.use(cors({
  origin: [
    'https://ashy-mud-0ac3ad21e.6.azurestaticapps.net',
    'http://localhost:3000',
  ],
  credentials: true
}));


app.get("/users/get", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT userID, username, fullName, phone, role, isActive, createdAt, updatedAt 
      FROM [Users]
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("❌ Lỗi khi truy vấn:", err);
    res.status(500).send("Lỗi server");
  }
});

app.post("/trash-weighings", async (req, res) => {
  const { trashBinCode, userID, weighingTime, weightKg, workShift, updatedAt, updatedBy, workDate } = req.body;

  try {
    const pool = await poolPromise;
    await pool.request()
      .input("trashBinCode", sql.NVarChar, trashBinCode)
      .input("userID", sql.Int, userID)
      .input("weighingTime", sql.DateTime, weighingTime)
      .input("weightKg", sql.Float, weightKg)
      .input("workShift", sql.NVarChar, workShift)
      .input("updatedAt", sql.DateTime, updatedAt)
      .input("updatedBy", sql.Int, updatedBy)
      .input("workDate", sql.Date, workDate)
      .query(`
        INSERT INTO TrashWeighings (trashBinCode, userID, weighingTime, weightKg, workShift, updatedAt, updatedBy, workDate)
        VALUES (@trashBinCode, @userID, @weighingTime, @weightKg, @workShift, @updatedAt, @updatedBy, @workDate)
      `);
    res.send("✅ Đã thêm bản ghi cân rác");
  } catch (err) {
    console.log(err)
    res.status(500).send("❌ Lỗi khi thêm dữ liệu");
  }
});

app.get("/history/date", async (req, res) => {
  const { date } = req.query;
  console.log(date);
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("date", sql.DateTime, new Date(date))
      .query(`
        SELECT
          U.fullName,
          D.departmentName,
          UN.unitName,
          T.trashName,
          B.trashBinCode,
          W.weighingTime,
          W.weightKg,
          W.workDate
        FROM TrashWeighings W
        JOIN Users U ON W.userID = U.userID        -- Thêm join với bảng Users để lấy tên người cân
        JOIN TrashBins B ON W.trashBinCode = B.trashBinCode
        JOIN Departments D ON B.departmentID = D.departmentID
        LEFT JOIN Units UN ON B.unitID = UN.unitID
        JOIN TrashTypes T ON B.trashTypeID = T.trashTypeID
        WHERE CAST(W.weighingTime AS DATE) = CAST(@date AS DATE)
        ORDER BY W.weighingTime DESC
      `);

      console.log(result.recordset)
    res.json(result.recordset);
  } catch (err) {
    console.log(err);
    res.status(500).send("❌ Lỗi khi truy vấn dữ liệu");
  }
});

app.get("/history", async (req, res) => {
  const { userID, date } = req.query;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("userID", sql.Int, userID)
      .input("date", sql.DateTime, new Date(date))
      .query(`
        SELECT 
          U.fullName, D.departmentName, UN.unitName, T.trashName, B.trashBinCode, W.weighingTime, W.weightKg
        FROM TrashWeighings W
        JOIN Users U ON W.userID = U.userID
        JOIN TrashBins B ON W.trashBinCode = B.trashBinCode
        JOIN Departments D ON B.departmentID = D.departmentID
        LEFT JOIN Units UN ON B.unitID = UN.unitID
        JOIN TrashTypes T ON B.trashTypeID = T.trashTypeID
        WHERE W.userID = @userID AND CAST(W.weighingTime AS DATE) = CAST(@date AS DATE)
        ORDER BY W.weighingTime DESC
      `);
    res.json(result.recordset);
  } catch (err) {
    console.log(err);
    res.status(500).send("❌ Lỗi khi truy vấn dữ liệu");
  }
});


app.get("/user/:id", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("userID", sql.Int, req.params.id)
      .query("SELECT userID, username, fullName, role, isActive, lastLogin FROM Users WHERE userID = @userID");
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).send("❌ Lỗi khi truy vấn user");
  }
});

app.put("/user/password", async (req, res) => {
  const { userID, oldPassword, newPassword } = req.body;
  try {
    const pool = await poolPromise;

    // Lấy password hash hiện tại
    const result = await pool.request()
      .input("userID", sql.Int, userID)
      .query("SELECT passwordHash FROM Users WHERE userID = @userID");

    if (result.recordset.length === 0) {
      return res.status(404).send("Người dùng không tồn tại");
    }

    const currentHash = result.recordset[0].passwordHash;

    // So sánh mật khẩu cũ
    const isMatch = await bcrypt.compare(oldPassword, currentHash);
    if (!isMatch) {
      return res.status(400).send("Mật khẩu cũ không đúng");
    }

    // Hash mật khẩu mới
    const hash = await bcrypt.hash(newPassword, 10);

    await pool.request()
      .input("userID", sql.Int, userID)
      .input("passwordHash", sql.NVarChar, hash)
      .query("UPDATE Users SET passwordHash = @passwordHash WHERE userID = @userID");

    res.send("✅ Mật khẩu đã được cập nhật");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Lỗi cập nhật mật khẩu");
  }
});

app.put("/user/:id", async (req, res) => {
  const { fullName, phone } = req.body;
  try {
    const pool = await poolPromise;
    // Update cả fullName và phone
    await pool.request()
      .input("userID", sql.Int, req.params.id)
      .input("fullName", sql.NVarChar, fullName)
      .input("phone", sql.NVarChar, phone)
      .query("UPDATE Users SET fullName = @fullName, phone = @phone WHERE userID = @userID");

    // Lấy lại user mới cập nhật
    const result = await pool.request()
      .input("userID", sql.Int, req.params.id)
      .query("SELECT userID, username, fullName, phone, role FROM Users WHERE userID = @userID");

    const userInfo = result.recordset[0];

    res.json({ 
      status: 'success',
      data: { user: userInfo }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Lỗi cập nhật thông tin");
  }
});


app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("username", sql.NVarChar, username)
      .query("SELECT * FROM Users WHERE username = @username");

    const user = result.recordset[0];
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).send({ 
        status: 'error',
      });
    }

    const accessToken = jwt.sign({ userID: user.userID }, SECRET, { expiresIn: "1h" });
    const refreshToken = jwt.sign({ userID: user.userID }, SECRET, { expiresIn: "7d" });

    
    const { passwordHash, ...userInfo } = user;

    res.json({ 
      status: 'success',
      data: {
        accessToken, 
        refreshToken,
        user: userInfo,
      }
    });
  } catch (err) {
    res.status(500).send({ 
      status: 'error',
    });
  }
});

app.post("/user", async (req, res) => {
  const { username, password, fullName, phone, role, createdBy } = req.body;
  try {
    const pool = await poolPromise;

    // ✅ Kiểm tra username đã tồn tại chưa
    const check = await pool.request()
      .input("username", sql.NVarChar, username)
      .query("SELECT * FROM Users WHERE username = @username");

    if (check.recordset.length > 0) {
      return res.status(400).send("❌ Username đã tồn tại");
    }

    // ✅ Nếu chưa có thì hash mật khẩu và thêm user
    const hash = await bcrypt.hash(password, 10);
    const now = new Date();

    await pool.request()
      .input("username", sql.NVarChar, username)
      .input("passwordHash", sql.NVarChar, hash)
      .input("fullName", sql.NVarChar, fullName)
      .input("phone", sql.NVarChar, phone)
      .input("role", sql.NVarChar, role)
      .input("isActive", sql.Bit, 1)
      .input("createdBy", sql.Int, createdBy)
      .input("createdAt", sql.DateTime, now)
      .query(`
        INSERT INTO Users (username, passwordHash, fullName, phone, role, isActive, createdBy, createdAt)
        VALUES (@username, @passwordHash, @fullName, @phone, @role, @isActive, @createdBy, @createdAt)
      `);

    res.send("✅ Đã thêm tài khoản");
  } catch (err) {
    console.log(err);
    res.status(500).send("❌ Lỗi tạo tài khoản");
  }
});


app.put("/user/deactivate/:id", async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request()
      .input("userID", sql.Int, req.params.id)
      .query("UPDATE Users SET isActive = 0 WHERE userID = @userID");
    res.send("✅ Tài khoản đã bị ngừng hoạt động");
  } catch (err) {
    res.status(500).send("❌ Lỗi khi ngừng tài khoản");
  }
});

function getTodayISO() {
  const now = new Date();
  now.setHours(now.getHours() + 7); // Giờ Việt Nam
  return now.toISOString().split("T")[0];
}

app.get('/api/statistics/today', async (req, res) => {
  try {
    const pool = await poolPromise;
    const today = getTodayISO();

    const result = await pool.request()
      .input('today', sql.Date, today)
      .query(`
        -- Tổng lượt cân hôm nay
        SELECT 
          (SELECT COUNT(*) FROM TrashWeighings WHERE CONVERT(date, weighingTime AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time') = @today) AS totalWeighings,

        -- Tổng khối lượng rác hôm nay
          (SELECT SUM(weightKg) FROM TrashWeighings WHERE CONVERT(date, weighingTime AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time') = @today) AS totalWeight,

        -- Bộ phận có nhiều rác nhất hôm nay
          (SELECT TOP 1 d.departmentName
           FROM TrashWeighings tw
           JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
           JOIN Departments d ON tb.departmentID = d.departmentID
           WHERE CONVERT(date, weighingTime AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time') = @today
           GROUP BY d.departmentName
           ORDER BY SUM(tw.weightKg) DESC) AS mostActiveDepartment,

        -- Loại rác nhiều nhất hôm nay
          (SELECT TOP 1 tt.trashName
           FROM TrashWeighings tw
           JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
           JOIN TrashTypes tt ON tb.trashTypeID = tt.trashTypeID
           WHERE CONVERT(date, weighingTime AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time') = @today
           GROUP BY tt.trashName
           ORDER BY SUM(tw.weightKg) DESC) AS mostCommonTrashType,

        -- Tổng tài khoản
          (SELECT COUNT(*) FROM Users) AS totalAccounts
      `);
      
    res.json({status: 'success', data: result.recordset[0]});
  } catch (err) {
    console.log('Error in /statistics/today:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/api/statistics/weight-by-department', async (req, res) => {
  try {
    const pool = await poolPromise;

    // Lấy ngày hôm nay theo giờ Việt Nam
    const now = new Date();
    now.setHours(now.getHours() + 7);
    const today = now.toISOString().split('T')[0];

    const result = await pool.request()
      .input('today', sql.Date, today)
      .query(`
        SELECT 
          d.departmentName AS name,
          ROUND(SUM(tw.weightKg), 2) AS weight
        FROM TrashWeighings tw
        JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
        JOIN Departments d ON tb.departmentID = d.departmentID
        WHERE CONVERT(date, weighingTime AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time') = @today
        GROUP BY d.departmentName
        ORDER BY weight DESC
      `);

    res.json({ status: 'success', data: result.recordset });
  } catch (err) {
    console.log('Error in /statistics/weight-by-department:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/api/statistics/today-percentage', async (req, res) => {
  try {
    const pool = await poolPromise;
    const today = getTodayISO();

    const result = await pool.request()
      .input('today', sql.Date, today)
      .query(`
        WITH TotalToday AS (
          SELECT SUM(weightKg) AS total
          FROM TrashWeighings
          WHERE CONVERT(date, weighingTime AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time') = @today
        )
        SELECT 
          tt.trashName AS name,
          SUM(tw.weightKg) AS value,
          CAST(SUM(tw.weightKg) * 100.0 / ttoday.total AS DECIMAL(5,2)) AS percentage
        FROM TrashWeighings tw
        JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
        JOIN TrashTypes tt ON tb.trashTypeID = tt.trashTypeID
        CROSS JOIN TotalToday ttoday
        WHERE CONVERT(date, weighingTime AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time') = @today
        GROUP BY tt.trashName, ttoday.total
        ORDER BY percentage DESC
      `);

    res.json({status: 'success', data: result.recordset});
  } catch (err) {
    console.log('Error in /statistics/today-percentage:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const TRASH_NAMES = [
    'Giẻ lau có chứa thành phần nguy hại',
    'Băng keo dính mực',
    'Keo bàn thải',
    'Mực in thải',
    'Vụn logo',
    'Lụa căng khung',
    'Rác sinh hoạt'
];
const SHIFTS = ['ca1', 'ca2', 'ca3', 'dai1', 'dai2'];

app.get('/api/statistics/weight-by-unit', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const pool = await poolPromise;
    const result = await pool.request() // ✅ Đúng
    .input('startDate', sql.Date, startDate)
    .input('endDate', sql.Date, endDate)
    .query(`
      SELECT 
          d.departmentName AS department,
          u.unitName AS unit,
          tt.trashName,
          tw.workShift,
          SUM(tw.weightKg) AS totalWeight
      FROM TrashWeighings tw
      JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
      JOIN TrashTypes tt ON tb.trashTypeID = tt.trashTypeID
      JOIN Departments d ON tb.departmentID = d.departmentID
      LEFT JOIN Units u ON tb.unitID = u.unitID
      WHERE tw.workDate BETWEEN @startDate AND @endDate
      GROUP BY 
          d.departmentName,
          u.unitName,
          tt.trashName,
          tw.workShift
    `);

    const rows = result.recordset;

    // Nhóm dữ liệu theo bộ phận + đơn vị
    const grouped = {};

    for (const row of rows) {
      const key = `${row.department}||${row.unit}`;
      if (!grouped[key]) {
        grouped[key] = {
          d: row.department,
          u: row.unit,
          weights: {}
        };
      }
      const subKey = `${row.trashName}__${row.workShift}`;
      grouped[key].weights[subKey] = row.totalWeight;
    }

    // Chuẩn hóa kết quả
    const finalResult = [];

    for (const key in grouped) {
      const item = grouped[key];
      const values = [];

      for (const trashName of TRASH_NAMES) {
        for (const shift of SHIFTS) {
          const w = item.weights[`${trashName}__${shift}`];
          values.push(w ? Math.round(w * 100) / 100 : 0);
        }
      }

      const total = values.reduce((acc, cur) => acc + cur, 0);
      finalResult.push({
        d: item.d,
        u: item.u,
        value: [...values, Math.round(total * 100) / 100]
      });
    }

    res.json({ status: 'success', data: finalResult });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



app.listen(port, () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
});
