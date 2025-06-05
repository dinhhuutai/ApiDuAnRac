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

app.delete('/users/delete/:id', async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('id', req.params.id)
      .query('DELETE FROM [Users] WHERE userID = @id');
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Lỗi khi xóa:', err);
    res.status(500).send('Lỗi server');
  }
});
app.delete('/history/delete/:id', async (req, res) => {
  const { id } = req.params;
console.log('id: ', id);
  try {
    const pool = await poolPromise;

    await pool
      .request()
      .input('id', sql.Int, id) // <-- Gán giá trị id an toàn
      .query('DELETE FROM [TrashWeighings] WHERE weighingID = @id'); // <-- Dùng @id

    res.status(200).json({ message: 'Xóa thành công' });
  } catch (error) {
    console.error('❌ Lỗi khi xóa dữ liệu lịch sử cân:', error);
    res.status(500).json({ message: 'Lỗi khi xóa dữ liệu lịch sử cân' });
  }
});

const teamUnitMap = {
  'Điều hành': [],
  'Chất lượng': [],
  'Bán hàng': [],
  'Kế hoạch': [],
  'IT - Bảo trì': [],
  'Văn phòng': [],
  'Vật tư': [],
  'Tổ canh hàng': ['Chuyền 1A'],
  'Tổ bổ sung': ['Chuyền 1B', 'Chuyền 2A-2B'],
  'Tổ mẫu': ['Chuyền 3A-3B'],
  'Tổ 3': ['Chuyền 1', 'Chuyền 2', 'Chuyền 3', 'Chuyền 4', 'Chuyền 5', 'Chuyền 6', 'Chuyền 7', 'Chuyền 8', 'Rác thải chung'],
  'Tổ 4': ['Chuyền 4A-4B', 'Chuyền 5A-5B', 'Chuyền 6A-6B', 'Chuyền 7A-7B', 'Chuyền 8A-8B', 'Chuyền 9A-9B', 'Chuyền 10A', 'Chuyền 11A', 'Chuyền 12A', 'Chuyền 13A', 'Chuyền 14A', 'Chuyền RB1', 'Chuyền RB2', 'Chuyền RB3', 'Rác thải chung'],
  'Tổ 5': ['Chuyền 10B', 'Chuyền 11B', 'Chuyền 12B', 'Chuyền 13B', 'Chuyền 14B', 'Rác thải chung'],
  'Tổ sửa hàng': [],
  'Tổ ép': [],
  'Tổ logo': [],
  'Kcs': [],
  'Chụp khung': [],
  'Pha màu': [],
};

app.get('/trash-weighings/unscanned-teams', async (req, res) => {
  const { workDate, workShift } = req.query;

  if (!workDate || !workShift) {
    return res.status(400).json({ message: 'Missing workDate or workShift' });
  }

  try {
    const pool = await poolPromise;

    const scannedResult = await pool.request()
      .input('workDate', sql.Date, workDate)
      .input('workShift', sql.NVarChar, workShift)
      .query(`
        SELECT DISTINCT trashBinCode FROM TrashWeighings
        WHERE workDate = @workDate AND workShift = @workShift
      `);

    const scannedUnits = scannedResult.recordset.map(r => r.trashBinCode);

    const result = [];
    for (const [team, units] of Object.entries(teamUnitMap)) {
      if (units.length === 0) continue;

      const isScanned = units.some(unit => scannedUnits.includes(unit));
      if (!isScanned) {
        result.push(team);
      }
    }

    res.json({ unscannedTeams: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching unscanned teams' });
  }
});


// GET /trash-weighings/check?trashBinCode=XXX&workShift=YYY&workDate=ZZZ

app.get("/trash-weighings/check", async (req, res) => {
  const { trashBinCode, workShift, workDate } = req.query;

  if (!trashBinCode || !workShift || !workDate) {
    return res.status(400).json({ message: "❌ Thiếu thông tin bắt buộc" });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("trashBinCode", sql.NVarChar, trashBinCode)
      .input("workShift", sql.NVarChar, workShift)
      .input("workDate", sql.Date, workDate)
      .query(`
        SELECT TOP 1 * FROM TrashWeighings
        WHERE trashBinCode = @trashBinCode AND workShift = @workShift AND workDate = @workDate
      `);

    if (result.recordset.length > 0) {
      const existing = result.recordset[0];
      return res.status(200).json({
        alreadyWeighed: true,
        previousWeight: existing.weightKg,
        existingData: existing,
      });
    } else {
      return res.status(200).json({ alreadyWeighed: false });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "❌ Lỗi khi kiểm tra dữ liệu cân" });
  }
});



app.post("/trash-weighings", async (req, res) => {
  const { trashBinCode, userID, weighingTime, weightKg, workShift, updatedAt, updatedBy, workDate, userName } = req.body;

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("trashBinCode", sql.NVarChar, trashBinCode)
      .input("userID", sql.Int, userID)
      .input("weighingTime", sql.DateTime, weighingTime)
      .input("weightKg", sql.Float, weightKg)
      .input("workShift", sql.NVarChar, workShift)
      .input("updatedAt", sql.DateTime, updatedAt)
      .input("updatedBy", sql.Int, updatedBy)
      .input("workDate", sql.Date, workDate)
      .input("userName", sql.NVarChar, userName)
      .query(`
        INSERT INTO TrashWeighings (trashBinCode, userID, weighingTime, weightKg, workShift, updatedAt, updatedBy, workDate, userName)
        OUTPUT INSERTED.weighingID
        VALUES (@trashBinCode, @userID, @weighingTime, @weightKg, @workShift, @updatedAt, @updatedBy, @workDate, @userName)
      `);

    
    const insertedId = result.recordset[0].weighingID;


    res.status(200).json({
      message: "✅ Đã thêm bản ghi cân rác",
      id: insertedId,
    });
  } catch (err) {
    console.log(err)
    res.status(500).send("❌ Lỗi khi thêm dữ liệu");
  }
});

app.get("/trash-weighings/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("id", sql.Int, id)
      .query("SELECT * FROM TrashWeighings WHERE id = @id");

    if (result.recordset.length === 0) {
      return res.status(404).send("❌ Không tìm thấy bản ghi cân rác");
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Lỗi khi truy vấn dữ liệu");
  }
});

app.put("/trash-weighings/:id", async (req, res) => {
  const { id } = req.params;

  console.log('id: ', id);
  const {
    weightKg,
    workShift,
    workDate,
    userName,
    updatedAt,
    updatedBy,
  } = req.body;

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("weighingID", sql.Int, id)
      .input("weightKg", sql.Float, weightKg)
      .input("workShift", sql.NVarChar, workShift)
      .input("workDate", sql.Date, workDate)
      .input("userName", sql.NVarChar, userName)
      .input("updatedAt", sql.DateTime, updatedAt)
      .input("updatedBy", sql.Int, updatedBy)
      .query(`
        UPDATE TrashWeighings
        SET
          weightKg = @weightKg,
          workShift = @workShift,
          workDate = @workDate,
          userName = @userName,
          updatedAt = @updatedAt,
          updatedBy = @updatedBy
        WHERE weighingID = @weighingID
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).send("❌ Không tìm thấy bản ghi để cập nhật");
    }

    res.send("✅ Đã cập nhật bản ghi cân rác");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Lỗi khi cập nhật dữ liệu");
  }
});


app.get("/history/date", async (req, res) => {
  const { date } = req.query;

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
          W.weighingID,
          W.weighingTime,
          W.weightKg,
          W.workDate,
          W.workShift,
          W.userName
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
const SHIFTS = ['ca1', 'ca2', 'ca3', 'dai1', 'dai2', 'cahc'];

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


app.get('/api/teammember/users', async (req, res) => {
  const role = req.query.role; // ✅ Lấy từ query string

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('role', sql.NVarChar, role)
      .query(`SELECT userID, fullName FROM Users WHERE role = @role AND isActive = 1`);
      
    res.json(result.recordset);
  } catch (err) {
    console.error("Query failed:", err); // Ghi rõ lỗi để debug
    res.status(500).send(err.message);
  }
});

// GET /api/team-members?userID=5
app.get('/api/team-members', async (req, res) => {
  try {
    const pool = await poolPromise;
    const userID = req.query.userID;
    const result = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        SELECT tm.teamMemberID, tm.name
        FROM TeamMembers tm
        INNER JOIN Users u ON tm.userID = u.userID
        WHERE u.role = 'user' AND tm.userID = @userID
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// POST /api/team-members
app.post('/api/team-members', async (req, res) => {
  const { name, userID } = req.body;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('name', sql.NVarChar, name)
      .input('userID', sql.Int, userID)
      .query(`INSERT INTO TeamMembers (name, userID) VALUES (@name, @userID)`);
    res.status(201).send('Team member created successfully');
  } catch (err) {
    console.error('Error inserting team member:', err);
    res.status(500).send(err.message);
  }
});

// DELETE /api/team-members/:id
app.delete('/api/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await poolPromise;
    await pool.request()
      .input('id', sql.Int, id)
      .query(`DELETE FROM TeamMembers WHERE teamMemberID = @id`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).send(err.message);
  }
});



app.listen(port, () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
});
