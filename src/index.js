require('dotenv').config();
const express = require("express");
const { sql, poolPromise } = require("./db");
const bcrypt = require("bcrypt");
const { DateTime } = require('luxon');

const uploadClassification = require('./middleware/uploadClassification');

const cors = require("cors");
const jwt = require("jsonwebtoken");
const { apiInkWeighing } = require('./InkWeighing/api');
const { apiFeedback } = require('./Feedback/api');
const { apiSuggestion } = require('./Suggestion/api');
const { apiUtilsConvert } = require('./UtilsConvert/api');
const SECRET = "Tai31072002@";

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());
app.use('/uploads', express.static('uploads'));


app.use(cors({
  origin: [
    'https://master.d3q09n8s04589q.amplifyapp.com',
    'https://master.d3q09n8s04589q.amplifyapp.com/login',
    'http://localhost:3000',
    'https://noibo.thuanhunglongan.com',
    'https://noibo.thuanhunglongan.com/login',
  ],
  credentials: true
}));

app.get('/', (req, res) => {
  res.status(200).send('API is running');
});

apiInkWeighing(app);
apiFeedback(app);
apiSuggestion(app);
apiUtilsConvert(app);

app.get("/users/get", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT 
        userID, username, fullName, phone, role, isActive, createdAt, updatedAt,
        operationType,
        roleEditReport, actionHistoryWeigh, managerQRcode,
        managerUser, managerTrash, managerTeamMember, managerFeedback
      FROM [Users]
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("❌ Lỗi khi truy vấn:", err);
    res.status(500).send("Lỗi server");
  }
});

app.get("/trashbins/get-id-by-names", async (req, res) => {
  const { departmentName, unitName, trashName } = req.query;

  try {
    const pool = await poolPromise;

    // 1. Lấy ID các bảng liên quan
    const result = await pool.request()
      .input("departmentName", sql.NVarChar, departmentName)
      .input("unitName", sql.NVarChar, unitName)
      .input("trashName", sql.NVarChar, trashName)
      .query(`
        IF @unitName = ''
        BEGIN
          -- Không lọc theo đơn vị
          SELECT 
            d.departmentID,
            NULL AS unitID,
            t.trashTypeID,
            b.trashBinID,
            b.trashBinCode,
            b.stringJsonCodeQr
          FROM TrashBins b
          JOIN Departments d ON b.departmentID = d.departmentID
          JOIN TrashTypes t ON b.trashTypeID = t.trashTypeID
          WHERE 
            b.unitID IS NULL AND
            LTRIM(RTRIM(d.departmentName)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@departmentName)) COLLATE Latin1_General_CI_AI AND
            LTRIM(RTRIM(t.trashName)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@trashName)) COLLATE Latin1_General_CI_AI;
        END
        ELSE
        BEGIN
          -- Có đơn vị, JOIN và lọc như bình thường
          SELECT 
            d.departmentID,
            u.unitID,
            t.trashTypeID,
            b.trashBinID,
            b.trashBinCode,
            b.stringJsonCodeQr
          FROM TrashBins b
          JOIN Departments d ON b.departmentID = d.departmentID
          JOIN Units u ON b.unitID = u.unitID
          JOIN TrashTypes t ON b.trashTypeID = t.trashTypeID
          WHERE 
            LTRIM(RTRIM(d.departmentName)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@departmentName)) COLLATE Latin1_General_CI_AI AND
            LTRIM(RTRIM(u.unitName)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@unitName)) COLLATE Latin1_General_CI_AI AND
            LTRIM(RTRIM(t.trashName)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@trashName)) COLLATE Latin1_General_CI_AI;
        END
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy thông tin phù hợp" });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error("❌ Lỗi khi truy vấn TrashBins:", err);
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
  'Tổ 3': ['Chuyền 1', 'Chuyền 2', 'Chuyền 3', 'Chuyền 4', 'Chuyền 5', 'Chuyền 6', 'Chuyền 7', 'Chuyền 8', 'Rác thải chung'],
  'Tổ 4': ['Chuyền 4A-4B', 'Chuyền 5A-5B', 'Chuyền 6A-6B', 'Chuyền 7A-7B', 'Chuyền 8A-8B', 'Chuyền 9A-9B', 'Chuyền 10A', 'Chuyền 11A', 'Chuyền 12A', 'Chuyền 13A', 'Chuyền 14A', 'Chuyền RB1', 'Chuyền RB2', 'Chuyền RB3', 'Rác thải chung'],
  'Tổ 5': ['Chuyền 10B', 'Chuyền 11B', 'Chuyền 12B', 'Chuyền 13B', 'Chuyền 14B', 'Rác thải chung'],
  'Tổ sửa hàng': [],
  'Tổ ép': [],
  'Tổ logo': [],
  'Kcs': [],
  'Chụp khung': [],
  'Pha màu': [],
};

app.get('/trash-weighings/tracking-scan', async (req, res) => {
  const { workDate, workShift } = req.query;

  if (!workDate || !workShift) {
    return res.status(400).json({ message: 'Thiếu workDate hoặc workShift' });
  }

  try {
    const pool = await poolPromise;

    const scannedResult = await pool.request()
      .input('workDate', sql.Date, workDate)
      .input('workShift', sql.NVarChar, workShift)
      .query(`
        SELECT DISTINCT 
          tb.trashBinCode,
          d.departmentName,
          u.unitName,
          tt.trashName,
          us.fullName
        FROM TrashWeighings tw
        JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
        JOIN Departments d ON tb.departmentID = d.departmentID
        LEFT JOIN Units u ON tb.unitID = u.unitID
        JOIN TrashTypes tt ON tb.TrashTypeID = tt.TrashTypeID
        JOIN Users us ON tw.userID = us.userID
        WHERE tw.workDate = @workDate AND tw.workShift = @workShift
      `);

    // ==============================
    // 1. Xử lý scannedMap (team => set(unit))
    // ==============================
    const scannedMap = new Map();
    for (const row of scannedResult.recordset) {
      const dept = row.departmentName?.trim();
      const unit = row.unitName?.trim();
      if (!scannedMap.has(dept)) {
        scannedMap.set(dept, new Set());
      }
      if (unit) {
        scannedMap.get(dept).add(unit);
      }
    }

    // ==============================
    // 2. Tính unscannedTeams
    // ==============================
    const unscannedTeams = {};
    for (const [team, units] of Object.entries(teamUnitMap)) {
      const scannedUnits = scannedMap.get(team) || new Set();

      if (units.length === 0) {
        if (!scannedMap.has(team)) {
          unscannedTeams[team] = [];
        }
      } else {
        const unscanned = units.filter(unit => !scannedUnits.has(unit));
        if (unscanned.length > 0) {
          unscannedTeams[team] = unscanned;
        }
      }
    }

    // ==============================
    // 3. Tính scannedTeams
    // ==============================
    const scannedTeams = {};
    for (const [team, units] of Object.entries(teamUnitMap)) {
      const scannedUnits = scannedMap.get(team) || new Set();

      if (units.length === 0) {
        if (scannedMap.has(team)) {
          scannedTeams[team] = [];
        }
      } else {
        const scanned = units.filter(unit => scannedUnits.has(unit));
        if (scanned.length > 0) {
          scannedTeams[team] = scanned;
        }
      }
    }

    // ==============================
    // 4. Gom toàn bộ bộ phận + đơn vị (kể cả chưa quét)
    // ==============================
    const groupedResults = {};
    for (const row of scannedResult.recordset) {
      const dept = row.departmentName?.trim();
      const unit = row.unitName?.trim() || null;
      const fullName = row.fullName?.trim() || null;
      const trashBinCode = row.trashBinCode?.trim();
      const trashName = row.trashName?.trim();

      const key = `${dept}|${unit}`;
      if (!groupedResults[key]) {
        groupedResults[key] = {
          departmentName: dept,
          unitName: unit,
          fullName: fullName,
          trashBinCodes: new Set(),
          trashNames: new Set(),
        };
      }

      if (trashBinCode) groupedResults[key].trashBinCodes.add(trashBinCode);
      if (trashName) groupedResults[key].trashNames.add(trashName);
    }

    const groupedScannedList = [];

    for (const [dept, units] of Object.entries(teamUnitMap)) {
      if (units.length === 0) {
        const key = `${dept}|null`;
        const item = groupedResults[key];

        groupedScannedList.push({
          departmentName: dept,
          unitName: null,
          fullName: item?.fullName || null,
          trashBinCodes: item ? Array.from(item.trashBinCodes) : [],
          trashNames: item ? Array.from(item.trashNames) : [],
          isScannedTeam: !!scannedTeams[dept],
          isUnscannedTeam: !!unscannedTeams[dept],
        });
      } else {
        for (const unit of units) {
          const key = `${dept}|${unit}`;
          const item = groupedResults[key];

          groupedScannedList.push({
            departmentName: dept,
            unitName: unit,
            fullName: item?.fullName || null,
            trashBinCodes: item ? Array.from(item.trashBinCodes) : [],
            trashNames: item ? Array.from(item.trashNames) : [],
            isScannedTeam:
              !!scannedTeams[dept] &&
              (scannedTeams[dept].length === 0 || scannedTeams[dept].includes(unit)),
            isUnscannedTeam:
              !!unscannedTeams[dept] &&
              (unscannedTeams[dept].length === 0 || unscannedTeams[dept].includes(unit)),
          });
        }
      }
    }

    // ==============================
    // 5. Trả kết quả
    // ==============================
    return res.json({
      unscannedTeams,
      scannedTeams,
      groupedScannedList,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Lỗi truy vấn dữ liệu' });
  }
});

app.get('/trash-weighings/longest-unscanned', async (req, res) => {
  try {
    const pool = await poolPromise;

    // 1. Lấy ngày cân gần nhất theo tổ - đơn vị
    const weighedResult = await pool.request().query(`
      SELECT 
        d.departmentName AS team,
        u.unitName AS unit,
        MAX(tw.workDate) AS lastWeighedDate
      FROM TrashWeighings tw
      JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
      JOIN Departments d ON tb.departmentID = d.departmentID
      LEFT JOIN Units u ON tb.unitID = u.unitID
      GROUP BY d.departmentName, u.unitName
    `);

    // 2. Tạo Map với key "team_unit" (xử lý unit null)
    const lastWeighedMap = new Map();
    for (const row of weighedResult.recordset) {
      const team = row.team?.trim() || '';
      const unit = row.unit?.trim() || '';
      const key = `${team}_${unit}`;
      lastWeighedMap.set(key, row.lastWeighedDate);
    }

    // 3. Tạo danh sách đầu ra từ teamUnitMap
    const today = new Date();
    const output = [];

    for (const [team, units] of Object.entries(teamUnitMap)) {
      if (units.length > 0) {
        for (const unit of units) {
          const key = `${team.trim()}_${unit.trim()}`;
          const lastWeighed = lastWeighedMap.get(key);
          const weighedDays = lastWeighed
            ? Math.floor((today - new Date(lastWeighed)) / (1000 * 60 * 60 * 24))
            : 9999;
          output.push({ team, unit, weighedDays });
        }
      } else {
        const key = `${team.trim()}_`;
        const lastWeighed = lastWeighedMap.get(key);
        const weighedDays = lastWeighed
          ? Math.floor((today - new Date(lastWeighed)) / (1000 * 60 * 60 * 24))
          : 9999;
        output.push({ team, unit: '', weighedDays });
      }
    }

    // 4. Sắp xếp giảm dần theo số ngày chưa cân, lấy top 15
    const sortedByUnweighed = [...output].sort((a, b) => b.weighedDays - a.weighedDays);
    const top15Unweighed = sortedByUnweighed.slice(0, 15);

    return res.json({
      top15Unweighed,
      fullList: sortedByUnweighed,
    });

  } catch (err) {
    console.error('Lỗi truy vấn:', err);
    res.status(500).json({ message: 'Lỗi truy vấn dữ liệu' });
  }
});


app.get('/trash-weighings/compare-weight-by-department', async (req, res) => {
  const { department1, department2 } = req.query;

  if (!department1 || !department2) {
    return res.status(400).json({ message: 'Thiếu department1 hoặc department2' });
  }

  try {
    const pool = await poolPromise;

    const result = await pool.request()
      .input('dep1', sql.NVarChar, department1)
      .input('dep2', sql.NVarChar, department2)
      .query(`
        SELECT 
          d.departmentName,
          tw.workDate,
          SUM(tw.weightKg) AS totalWeight
        FROM TrashWeighings tw
        JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
        JOIN Departments d ON tb.departmentID = d.departmentID
        WHERE d.departmentName IN (@dep1, @dep2)
          AND tw.workDate >= DATEADD(DAY, -6, CAST(GETDATE() AS DATE)) -- 7 ngày gần nhất
        GROUP BY d.departmentName, tw.workDate
        ORDER BY tw.workDate ASC
      `);

    // Chuẩn hoá dữ liệu cho biểu đồ
    const dateMap = new Map(); // workDate => { dep1: weight, dep2: weight }

    for (const row of result.recordset) {
      const dateStr = row.workDate.toISOString().split('T')[0];
      if (!dateMap.has(dateStr)) {
        dateMap.set(dateStr, { [department1]: 0, [department2]: 0 });
      }
      dateMap.get(dateStr)[row.departmentName] = parseFloat(row.totalWeight);
    }

    // Trả dữ liệu dạng mảng ngày và 2 cột
    const chartData = Array.from(dateMap.entries()).map(([date, values]) => ({
      date,
      [department1]: values[department1] || 0,
      [department2]: values[department2] || 0
    }));

    return res.json({ chartData });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Lỗi truy vấn dữ liệu' });
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

  const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("trashBinCode", sql.NVarChar, trashBinCode)
      .input("userID", sql.Int, userID)
      .input("weighingTime", sql.DateTime, nowVN)
      .input("weightKg", sql.Float, weightKg)
      .input("workShift", sql.NVarChar, workShift)
      .input("updatedAt", sql.DateTime, nowVN)
      .input("updatedBy", sql.Int, updatedBy)
      .input("workDate", sql.Date, workDate)
      .input("userName", sql.NVarChar, userName)
      .query(`
  DECLARE @output TABLE (weighingID INT);

  INSERT INTO TrashWeighings (
    trashBinCode, userID, weighingTime, weightKg, workShift, 
    updatedAt, updatedBy, workDate, userName
  )
  OUTPUT INSERTED.weighingID INTO @output
  VALUES (
    @trashBinCode, @userID, @weighingTime, @weightKg, @workShift,
    @updatedAt, @updatedBy, @workDate, @userName
  );

  SELECT * FROM @output;
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

  const {
    weightKg,
    workShift,
    workDate,
    userName,
    updatedAt,
    updatedBy,
  } = req.body;
  
  const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("weighingID", sql.Int, id)
      .input("weightKg", sql.Float, weightKg)
      .input("workShift", sql.NVarChar, workShift)
      .input("workDate", sql.Date, workDate)
      .input("userName", sql.NVarChar, userName)
      .input("updatedAt", sql.DateTime, nowVN)
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

app.put("/users/update/:userID", async (req, res) => {
  const userID = parseInt(req.params.userID);
  const {
    fullName,
    phone,
    password, // Nếu muốn update password luôn
    operationType,
    roleEditReport,
    actionHistoryWeigh,
    managerQRcode,
    managerUser,
    managerTrash,
    managerTeamMember,
    managerFeedback,
  } = req.body;

  try {
    const pool = await poolPromise;

    // Nếu có password => hash lại
    let passwordHash = null;
    if (password && password.trim() !== "") {
      const bcrypt = require("bcrypt");
      passwordHash = await bcrypt.hash(password, 10);
    }

    const request = pool.request()
      .input("userID", sql.Int, userID)
      .input("fullName", sql.NVarChar, fullName)
      .input("phone", sql.NVarChar, phone)
      .input("operationType", sql.NVarChar, operationType)
      .input("roleEditReport", sql.Bit, roleEditReport)
      .input("actionHistoryWeigh", sql.Bit, actionHistoryWeigh)
      .input("managerQRcode", sql.Bit, managerQRcode)
      .input("managerUser", sql.Bit, managerUser)
      .input("managerTrash", sql.Bit, managerTrash)
      .input("managerTeamMember", sql.Bit, managerTeamMember)
      .input("managerFeedback", sql.Bit, managerFeedback);

    if (passwordHash) {
      request.input("passwordHash", sql.NVarChar, passwordHash);
    }

    await request.query(`
      UPDATE Users SET
        fullName = @fullName,
        phone = @phone,
        ${passwordHash ? "passwordHash = @passwordHash," : ""}
        operationType = @operationType,
        roleEditReport = @roleEditReport,
        actionHistoryWeigh = @actionHistoryWeigh,
        managerQRcode = @managerQRcode,
        managerUser = @managerUser,
        managerTrash = @managerTrash,
        managerTeamMember = @managerTeamMember,
        managerFeedback = @managerFeedback,
        updatedAt = GETDATE()
      WHERE userID = @userID
    `);

    res.send("✅ Đã cập nhật người dùng");
  } catch (err) {
    console.error("❌ Lỗi khi cập nhật người dùng:", err);
    res.status(500).send("❌ Lỗi server");
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
  const { username, password, fullName, phone, role, createdBy, operationType, roleEditReport, actionHistoryWeigh, managerQRcode, managerUser, managerTrash, managerTeamMember, managerFeedback } = req.body;
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

    const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

    await pool.request()
      .input("username", sql.NVarChar, username)
      .input("passwordHash", sql.NVarChar, hash)
      .input("fullName", sql.NVarChar, fullName)
      .input("phone", sql.NVarChar, phone)
      .input("role", sql.NVarChar, role)
      .input("isActive", sql.Bit, 1)
      .input("createdBy", sql.Int, createdBy)
      .input("createdAt", sql.DateTime, nowVN)
      .input("operationType", sql.NVarChar, operationType)
      .input("roleEditReport", sql.Bit, roleEditReport)
      .input("actionHistoryWeigh", sql.Bit, actionHistoryWeigh)
      .input("managerQRcode", sql.Bit, managerQRcode)
      .input("managerUser", sql.Bit, managerUser)
      .input("managerTrash", sql.Bit, managerTrash)
      .input("managerTeamMember", sql.Bit, managerTeamMember)
      .input("managerFeedback", sql.Bit, managerFeedback)
      .query(`
        INSERT INTO Users (username, passwordHash, fullName, phone, role, isActive, createdBy, createdAt, operationType, roleEditReport, actionHistoryWeigh, managerQRcode, managerUser, managerTrash, managerTeamMember, managerFeedback)
        VALUES (@username, @passwordHash, @fullName, @phone, @role, @isActive, @createdBy, @createdAt, @operationType, @roleEditReport, @actionHistoryWeigh, @managerQRcode, @managerUser, @managerTrash, @managerTeamMember, @managerFeedback)
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
          (SELECT COUNT(*) FROM TrashWeighings WHERE CONVERT(date, weighingTime) = @today) AS totalWeighings,

        -- Tổng khối lượng rác hôm nay
          (SELECT SUM(weightKg) FROM TrashWeighings WHERE CONVERT(date, weighingTime) = @today) AS totalWeight,

        -- Bộ phận có nhiều rác nhất hôm nay
          (SELECT TOP 1 d.departmentName
           FROM TrashWeighings tw
           JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
           JOIN Departments d ON tb.departmentID = d.departmentID
           WHERE CONVERT(date, weighingTime) = @today
           GROUP BY d.departmentName
           ORDER BY SUM(tw.weightKg) DESC) AS mostActiveDepartment,

        -- Loại rác nhiều nhất hôm nay
          (SELECT TOP 1 tt.trashName
           FROM TrashWeighings tw
           JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
           JOIN TrashTypes tt ON tb.trashTypeID = tt.trashTypeID
           WHERE CONVERT(date, weighingTime) = @today
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
        WHERE CONVERT(date, weighingTime) = @today
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
          WHERE CONVERT(date, weighingTime) = @today
        )
        SELECT 
          tt.trashName AS name,
          SUM(tw.weightKg) AS value,
          CAST(SUM(tw.weightKg) * 100.0 / ttoday.total AS DECIMAL(5,2)) AS percentage
        FROM TrashWeighings tw
        JOIN TrashBins tb ON tw.trashBinCode = tb.trashBinCode
        JOIN TrashTypes tt ON tb.trashTypeID = tt.trashTypeID
        CROSS JOIN TotalToday ttoday
        WHERE CONVERT(date, weighingTime) = @today
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
    'Giẻ lau dính lapa',
    'Băng keo dính mực',
    'Keo bàn thải',
    'Mực in thải',
    'Mực in lapa thải',
    'Vụn logo',
    'Lụa căng khung',
    'Rác sinh hoạt'
];
const SHIFTS = ['ca1', 'ca2', 'ca3', 'dai1', 'dai2', 'cahc', null];

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
      WHERE ISNULL(tw.workDate, tw.weighingTime) BETWEEN @startDate AND @endDate
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

    const normalizeStr = str => str.normalize("NFC");
    for (const key in grouped) {
      const item = grouped[key];
      const values = [];

      for (const trashName of TRASH_NAMES) {
        for (const shift of SHIFTS) {
          const w = item.weights[`${normalizeStr(trashName)}__${shift}`];
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

app.get('/departments', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.query(`SELECT departmentID, departmentName FROM Departments WHERE areaName = N'Sản xuất'`);
    res.json(result.recordset);
  } catch (err) {
    console.error('Lỗi khi lấy danh sách bộ phận:', err);
    res.status(500).json({ error: 'Không thể lấy danh sách bộ phận' });
  }
});

// GET /api/departments
app.get('/api/departments', async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'Thiếu tham số date' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('date', sql.Date, date)
      .query(`
        SELECT DISTINCT d.departmentID, d.departmentName
        FROM Departments d
        LEFT JOIN Units u ON d.departmentID = u.departmentID
        LEFT JOIN ClassificationChecks c ON (
          c.departmentID = d.departmentID 
          AND (c.unitID = u.unitID OR (c.unitID IS NULL AND u.unitID IS NULL))
          AND CAST(c.checkTime AS DATE) = @date
        )
        WHERE d.areaName = N'Sản xuất'
          AND c.classificationCheckID IS NULL
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
    console.log(err.message);
  }
});

// GET /api/units?departmentId=1
app.get('/api/units', async (req, res) => {
  const { departmentId, date } = req.query;

  if (!departmentId || !date) {
    return res.status(400).json({ error: 'Thiếu departmentId hoặc date' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('departmentId', sql.Int, departmentId)
      .input('date', sql.Date, date)
      .query(`
        SELECT u.unitID, u.unitName, u.departmentID
        FROM Units u
        LEFT JOIN ClassificationChecks c ON (
          u.unitID = c.unitID AND CAST(c.checkTime AS DATE) = @date
        )
        WHERE u.departmentID = @departmentID
          AND c.classificationCheckID IS NULL
      `);

    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/trash-bin-in-areas?departmentID=1&unitID=2
app.get('/trash-bin-in-areas', async (req, res) => {
  const { departmentID, unitID } = req.query;

  try {
    const pool = await poolPromise;

    const result = await pool.request()
      .input('departmentID', sql.Int, departmentID)
      .input('unitID', sql.Int, unitID || null)
      .query(`
        SELECT 
          a.trashBinInAreaID,
          b.TrashBinInAreaCurrentID,
          a.trashType,
          a.trashName,
          a.quantity AS expectedQuantity,
          ISNULL(b.quantity, 0) AS actualQuantity
        FROM TrashBinInAreas a
        LEFT JOIN TrashBinInAreaCurrents b 
          ON a.departmentID = b.departmentID 
          AND ((a.unitID IS NULL AND b.unitID IS NULL) OR a.unitID = b.unitID)
          AND a.trashType = b.trashType
          AND a.trashName = b.trashName
        WHERE a.departmentID = @departmentID AND (a.unitID = @unitID OR @unitID IS NULL)
      `);

    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

app.post('/submit-classification', uploadClassification.array('images', 10), async (req, res) => {
  const department = JSON.parse(req.body.department);
const unit = JSON.parse(req.body.unit);
const trashBins = JSON.parse(req.body.trashBins);
const feedbackNote = req.body.feedbackNote || '';
const user = parseInt(req.body.user, 10); // Vì formData sẽ gửi kiểu string

  const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

  try {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);

    await transaction.begin();

    // 1. Insert vào ClassificationChecks
    const insertCheck = await transaction.request()
      .input('departmentID', sql.Int, department.id)
      .input('unitID', sql.Int, unit.id)
      .input('checkTime', sql.DateTime, nowVN)
      .input('feedbackNote', sql.NVarChar, feedbackNote || '')
      .input('userID', sql.Int, user)
      .query(`
        INSERT INTO ClassificationChecks (departmentID, unitID, checkTime, feedbackNote, userID)
        OUTPUT INSERTED.classificationCheckID
        VALUES (@departmentID, @unitID, @checkTime, @feedbackNote, @userID)
      `);

    const newCheckID = insertCheck.recordset[0].classificationCheckID;

    
    // Lưu hình ảnh
    const files = req.files || [];
    for (const file of files) {
  await transaction.request()
    .input("classificationCheckID", sql.Int, newCheckID)
    .input("imageUrl", sql.NVarChar, file.path)
    .query(`
      INSERT INTO ClassificationCheckImages (classificationCheckID, imageUrl)
      VALUES (@classificationCheckID, @imageUrl)
    `);
}

    // 2. Insert vào InfoClassificationChecks
    for (const bin of trashBins) {
      await transaction.request()
        .input('classificationCheckID', sql.Int, newCheckID)
        .input('trashBinInAreaID', sql.Int, bin.trashBinInAreaID)
        .input('trashBinInAreaCurrentID', sql.Int, bin.TrashBinInAreaCurrentID)
        .input('quantity', sql.Int, bin.actualQuantity || 0)
        .input('isCorrectlyClassified', sql.Bit, bin.isCorrect ?? true)
        .input('createdBy', sql.Int, user)
        .input('createdAt', sql.DateTime, nowVN)
        .query(`
          INSERT INTO InfoClassificationChecks (classificationCheckID, trashBinInAreaID, trashBinInAreaCurrentID, quantity, isCorrectlyClassified, createdBy, createdAt)
          VALUES (@classificationCheckID, @trashBinInAreaID, @trashBinInAreaCurrentID, @quantity, @isCorrectlyClassified, @createdBy, @createdAt)
        `);

          // 👉 Cập nhật quantity mới cho bảng TrashBinInAreaCurrents
      await transaction.request()
        .input('trashBinInAreaCurrentID', sql.Int, bin.TrashBinInAreaCurrentID)
        .input('quantity', sql.Int, bin.actualQuantity || 0)
        .input('updatedBy', sql.Int, user)
        .input('updatedAt', sql.DateTime, nowVN)
        .query(`
          UPDATE TrashBinInAreaCurrents
          SET quantity = @quantity,
              updatedBy = @updatedBy,
              updatedAt = @updatedAt
          WHERE trashBinInAreaCurrentID = @trashBinInAreaCurrentID
        `);
    }

    await transaction.commit();
    res.json({ success: true, message: 'Dữ liệu đã được lưu thành công' });
  } catch (err) {
    console.error('Lỗi khi lưu dữ liệu:', err);

    res.status(500).json({ success: false, message: 'Lỗi server khi lưu dữ liệu' });
  }
});


// GET /classification-history?date=YYYY-MM-DD&departmentId=1
app.get('/classification-history', async (req, res) => {
  const { date, departmentId } = req.query;

  if (!date) {
    return res.status(400).json({ success: false, message: 'Thiếu tham số ngày (date)' });
  }

  try {
    const pool = await poolPromise;

    let query = `
      SELECT 
        c.classificationCheckID,
        c.checkTime,
        c.feedbackNote,
        d.departmentName,
        u.unitName,
        us.fullName AS userName,
        i.trashBinInAreaCurrentID,
        i.quantity,
        i.isCorrectlyClassified,
        i.createdAt,
        t.trashName,
        t.quantity as ruleQuantity
      FROM ClassificationChecks c
      INNER JOIN Departments d ON c.departmentID = d.departmentID
      LEFT JOIN Units u ON c.unitID = u.unitID
      INNER JOIN Users us ON c.userID = us.userID
      LEFT JOIN InfoClassificationChecks i ON c.classificationCheckID = i.classificationCheckID
      LEFT JOIN TrashBinInAreas t ON i.trashBinInAreaID = t.trashBinInAreaID
      WHERE CAST(c.checkTime AS DATE) = @date
    `;

    if (departmentId) {
      query += ' AND c.departmentID = @departmentId';
    }

    query += ' ORDER BY c.checkTime DESC, i.createdAt ASC';

    const request = pool.request().input('date', sql.Date, date);
    if (departmentId) {
      request.input('departmentId', sql.Int, departmentId);
    }

    const result = await request.query(query);

    // Gom nhóm dữ liệu
    const grouped = {};
    result.recordset.forEach(row => {
      const id = row.classificationCheckID;
      if (!grouped[id]) {
        grouped[id] = {
          checkID: id,
          departmentName: row.departmentName,
          unitName: row.unitName,
          checkTime: row.checkTime,
          feedbackNote: row.feedbackNote,
          userName: row.userName,
          details: []
        };
      }
      if (row.trashBinInAreaCurrentID !== null) {
        grouped[id].details.push({
          trashBinInAreaCurrentID: row.trashBinInAreaCurrentID,
          quantity: row.quantity,
          isCorrectlyClassified: row.isCorrectlyClassified,
          createdAt: row.createdAt,
          trashName: row.trashName,
          ruleQuantity: row.ruleQuantity,
        });
      }
    });

    // Truy vấn thêm ảnh
const checkIds = Object.keys(grouped).map((id) => parseInt(id));
if (checkIds.length > 0) {
  const imageResult = await pool.request()
    .query(`SELECT classificationCheckID, imageUrl FROM ClassificationCheckImages WHERE classificationCheckID IN (${checkIds.join(',')})`);

  imageResult.recordset.forEach((img) => {
    if (grouped[img.classificationCheckID]) {
      if (!grouped[img.classificationCheckID].images) {
        grouped[img.classificationCheckID].images = [];
      }
      grouped[img.classificationCheckID].images.push(img.imageUrl);
    }
  });
}

    res.json({ success: true, data: Object.values(grouped) });
  } catch (err) {
    console.error('Lỗi lấy lịch sử phân loại:', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

app.delete('/classification-history/:id', async (req, res) => {
  const { id } = req.params;
  const pool = await poolPromise;
  try {
    await pool.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM ClassificationCheckImages WHERE classificationCheckID = @id');

    await pool.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM InfoClassificationChecks WHERE classificationCheckID = @id');

    await pool.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM ClassificationChecks WHERE classificationCheckID = @id');

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Không thể xoá' });
  }
});

// GET /api/bin-summary
app.get('/api/bin-summary', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT 
        d.departmentName AS departmentName,
        ISNULL(u.unitName, N'') AS unitName,
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%dính mực thường%' THEN t.quantity ELSE 0 END) AS [Giẻ lau dính mực thường],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%dính mực lapa%' THEN t.quantity ELSE 0 END) AS [Giẻ lau dính mực lapa],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%vụn logo%' THEN t.quantity ELSE 0 END) AS [Vụn logo],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%keo%' THEN t.quantity ELSE 0 END) AS [Băng keo dính hóa chất],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%thường thải%' THEN t.quantity ELSE 0 END) AS [Mực in thường thải],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%lapa thải%' THEN t.quantity ELSE 0 END) AS [Mực in lapa thải],
        SUM(t.quantity) AS totalQuantity
      FROM TrashBinInAreas t
      LEFT JOIN Departments d ON t.departmentID = d.departmentID
      LEFT JOIN Units u ON t.unitID = u.unitID
      GROUP BY d.departmentName, u.unitName
      ORDER BY d.departmentName, u.unitName;
    `);

    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bin-standard
app.get('/api/bin-standard', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT 
        d.departmentName AS departmentName,
        ISNULL(u.unitName, N'') AS unitName,
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%dính mực thường%' THEN t.quantity ELSE 0 END) AS [Giẻ lau dính mực thường],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%dính mực lapa%' THEN t.quantity ELSE 0 END) AS [Giẻ lau dính mực lapa],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%vụn logo%' THEN t.quantity ELSE 0 END) AS [Vụn logo],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%keo%' THEN t.quantity ELSE 0 END) AS [Băng keo dính hóa chất],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%thường thải%' THEN t.quantity ELSE 0 END) AS [Mực in thường thải],
        SUM(CASE WHEN t.trashName COLLATE Vietnamese_CI_AI LIKE N'%lapa thải%' THEN t.quantity ELSE 0 END) AS [Mực in lapa thải],
        SUM(t.quantity) AS totalQuantity
      FROM TrashBinInAreaCurrents t
      LEFT JOIN Departments d ON t.departmentID = d.departmentID
      LEFT JOIN Units u ON t.unitID = u.unitID
      GROUP BY d.departmentName, u.unitName
      ORDER BY d.departmentName, u.unitName;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.log(err)
    res.status(500).json({ error: err.message });
  }
});

app.get("/trash-types", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .query(`
        SELECT trashTypeID, trashType, trashName
        FROM TrashTypes
        ORDER BY trashName
      `);

    res.status(200).json(result.recordset);
  } catch (err) {
    console.error("❌ Lỗi khi truy vấn TrashTypes:", err);
    res.status(500).send("Lỗi máy chủ khi lấy loại rác.");
  }
});

app.post("/garbage-trucks", async (req, res) => {
  const { truckName, trashTypeIDs, truckCode } = req.body;

  const nowVN = DateTime.now().setZone("Asia/Ho_Chi_Minh").toFormat("yyyy-MM-dd HH:mm:ss");

  if (!Array.isArray(trashTypeIDs) || trashTypeIDs.length === 0) {
    return res.status(400).json({ message: "⚠️ Vui lòng chọn ít nhất một loại rác." });
  }

  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const request = new sql.Request(transaction);

    // 1. Thêm vào bảng GarbageTrucks
    const truckResult = await request
      .input("truckName", sql.NVarChar, truckName)
      .input("truckCode", sql.NVarChar, truckCode)
      .input("createdAt", sql.DateTime, nowVN)
      .query(`
        INSERT INTO GarbageTrucks (truckName, truckCode, createdAt)
        OUTPUT INSERTED.garbageTruckID
        VALUES (@truckName, @truckCode, @createdAt)
      `);

    const insertedTruckId = truckResult.recordset[0].garbageTruckID;

    // 2. Thêm vào bảng trung gian GarbageTruckTrashTypes
    for (const trashTypeID of trashTypeIDs) {
      const typeRequest = new sql.Request(transaction); // Tạo request mới trong mỗi vòng lặp
      await typeRequest
        .input("garbageTruckID", sql.Int, insertedTruckId)
        .input("trashTypeID", sql.Int, trashTypeID)
        .query(`
          INSERT INTO GarbageTruckTrashTypes (garbageTruckID, trashTypeID)
          VALUES (@garbageTruckID, @trashTypeID)
        `);
    }

    await transaction.commit();

    res.status(200).json({
      message: "✅ Thêm xe rác và loại rác thành công!",
      id: insertedTruckId,
    });

  } catch (err) {
    console.error("❌ Lỗi thêm xe rác:", err);

    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error("⚠️ Lỗi khi rollback:", rollbackErr);
    }

    if (err.number === 2627) {
      res.status(400).json({ message: "⚠️ Mã xe đã tồn tại." });
    } else {
      res.status(500).json({ message: "❌ Lỗi khi thêm xe rác." });
    }
  }
});


app.get("/garbage-trucks", async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool.request().query(`
      SELECT 
        gt.garbageTruckID,
        gt.truckName,
        gt.truckCode,
        gt.weightKg,
        gt.createdAt,
        tt.trashTypeID,
        tt.trashName,
        tt.trashType
      FROM GarbageTrucks gt
      JOIN GarbageTruckTrashTypes gttt ON gt.garbageTruckID = gttt.garbageTruckID
      JOIN TrashTypes tt ON gttt.trashTypeID = tt.trashTypeID
      ORDER BY gt.createdAt DESC
    `);

    const grouped = {};

    for (const row of result.recordset) {
      const {
        garbageTruckID,
        truckName,
        truckCode,
        weightKg,
        createdAt,
        trashName,
        trashType,
        trashTypeID,
      } = row;

      if (!grouped[garbageTruckID]) {
        grouped[garbageTruckID] = {
          garbageTruckID,
          truckName,
          truckCode,
          weightKg,
          createdAt,
          trashTypes: [],       // chứa dạng string hiển thị
          trashTypeIDs: [],     // chứa ID để dùng trong checkbox
        };
      }

      grouped[garbageTruckID].trashTypes.push(`${trashName} (${trashType})`);
      grouped[garbageTruckID].trashTypeIDs.push(trashTypeID);
    }

    const data = Object.values(grouped);
    res.status(200).json(data);
  } catch (err) {
    console.error("❌ Lỗi khi lấy danh sách xe rác:", err);
    res.status(500).send("Lỗi khi lấy danh sách xe rác.");
  }
});

app.put('/garbage-trucks/:id', async (req, res) => {
  const { id } = req.params;
  const { truckName, trashTypeIDs } = req.body;

  if (!Array.isArray(trashTypeIDs) || trashTypeIDs.length === 0) {
    return res.status(400).json({ message: "⚠️ Vui lòng chọn ít nhất một loại rác." });
  }

  try {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    // Tạo request cho transaction
    let request = new sql.Request(transaction);

    // 1. Cập nhật tên xe
    await request
      .input('garbageTruckID', sql.Int, id)
      .input('truckName', sql.NVarChar(100), truckName)
      .query(`
        UPDATE GarbageTrucks
        SET truckName = @truckName
        WHERE garbageTruckID = @garbageTruckID
      `);

    // 2. Xóa loại rác cũ
    request = new sql.Request(transaction); // ❗ Tạo mới tránh trùng tham số
    await request
      .input('garbageTruckID', sql.Int, id)
      .query(`
        DELETE FROM GarbageTruckTrashTypes WHERE garbageTruckID = @garbageTruckID
      `);

    // 3. Thêm lại loại rác mới
    for (const trashTypeID of trashTypeIDs) {
      request = new sql.Request(transaction); // ❗ Luôn tạo mới
      await request
        .input('garbageTruckID', sql.Int, id)
        .input('trashTypeID', sql.Int, trashTypeID)
        .query(`
          INSERT INTO GarbageTruckTrashTypes (garbageTruckID, trashTypeID)
          VALUES (@garbageTruckID, @trashTypeID)
        `);
    }

    await transaction.commit();
    res.json({ message: '✅ Cập nhật xe rác thành công.' });
  } catch (error) {
    console.error('❌ Lỗi khi cập nhật xe rác:', error);
    res.status(500).json({ error: 'Lỗi server khi cập nhật xe rác.' });
  }
});

// DELETE /api/garbage-trucks/:id
app.delete('/garbage-trucks/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    // 1. Xoá các loại rác liên kết
    let request = new sql.Request(transaction);
    await request
      .input('garbageTruckID', sql.Int, id)
      .query('DELETE FROM GarbageTruckTrashTypes WHERE garbageTruckID = @garbageTruckID');

    // 2. Xoá xe rác chính
    request = new sql.Request(transaction);
    const result = await request
      .input('garbageTruckID', sql.Int, id)
      .query('DELETE FROM GarbageTrucks WHERE garbageTruckID = @garbageTruckID');

    if (result.rowsAffected[0] === 0) {
      await transaction.rollback();
      return res.status(404).json({ message: "Không tìm thấy xe rác." });
    }

    await transaction.commit();
    res.json({ message: "✅ Đã xóa xe rác thành công." });
  } catch (err) {
    console.error("❌ Lỗi khi xóa xe rác:", err);
    res.status(500).json({ message: "Lỗi máy chủ khi xóa." });
  }
});

app.post("/garbage-trucks/filter", async (req, res) => {
  const { trashTypeIDs } = req.body;
  if (!Array.isArray(trashTypeIDs) || trashTypeIDs.length === 0) {
    return res.status(400).json({ message: "Vui lòng chọn ít nhất 1 loại rác." });
  }

  try {
    const pool = await poolPromise;

    const result = await pool.request().query(`
      SELECT gt.*, gttt.trashTypeID
      FROM GarbageTrucks gt
      JOIN GarbageTruckTrashTypes gttt ON gt.garbageTruckID = gttt.garbageTruckID
    `);

    const grouped = {};
    for (const row of result.recordset) {
      const id = row.garbageTruckID;
      if (!grouped[id]) {
        grouped[id] = {
          garbageTruckID: id,
          truckName: row.truckName,
          truckCode: row.truckCode,
          weightKg: row.weightKg || 0,
          createdAt: row.createdAt,
          trashTypeIDs: [],
        };
      }
      grouped[id].trashTypeIDs.push(row.trashTypeID);
    }

    const filtered = Object.values(grouped).filter(truck =>
      trashTypeIDs.every(tid => truck.trashTypeIDs.includes(tid))
    );

    res.json(filtered);
  } catch (err) {
    console.error("❌ Lỗi lọc xe:", err);
    res.status(500).send("Lỗi server");
  }
});

app.get("/weighing-records", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT * FROM WeighingRecords
      WHERE truckCode IS NULL
      ORDER BY createdAt ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("❌ Lỗi lấy cân:", err);
    res.status(500).send("Lỗi server");
  }
});

app.post("/assign-weight", async (req, res) => {
  const { truckCode, weightKg, recordIDs } = req.body;

  if (!truckCode || !Array.isArray(recordIDs) || recordIDs.length === 0) {
    return res.status(400).json({ message: "Thiếu dữ liệu." });
  }

  try {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    const request = new sql.Request(transaction);

    // Cập nhật truckCode cho các bản ghi cân
    for (const id of recordIDs) {
      const updateRequest = new sql.Request(transaction);
      await updateRequest
        .input("truckCode", sql.NVarChar, truckCode)
        .input("id", sql.Int, id)
        .query("UPDATE WeighingRecords SET truckCode = @truckCode WHERE weighingRecordID = @id");
    }

    // Cập nhật tổng weight vào GarbageTrucks
    const updateTruckRequest = new sql.Request(transaction);
    await updateTruckRequest
      .input("weightKg", sql.Float, weightKg)
      .input("truckCode", sql.NVarChar, truckCode)
      .query("UPDATE GarbageTrucks SET weightKg = @weightKg WHERE truckCode = @truckCode");

    await transaction.commit();

    res.json({ message: "Phân xe và gán khối lượng thành công." });
  } catch (err) {
    console.error("❌ Lỗi gán:", err);
    res.status(500).send("Lỗi khi gán dữ liệu.");
  }
});

app.put("/garbage-trucks/:truckCode/reload", async (req, res) => {
  const { truckCode } = req.params;

  try {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    // 1. Xóa truckCode ở bảng WeighingRecords
    const clearWeighing = new sql.Request(transaction);
    await clearWeighing
      .input("truckCode", sql.NVarChar, truckCode)
      .query(`
        UPDATE WeighingRecords
        SET truckCode = NULL
        WHERE truckCode = @truckCode
      `);

    // 2. Reset weightKg ở GarbageTrucks
    const resetTruck = new sql.Request(transaction);
    await resetTruck
      .input("truckCode", sql.NVarChar, truckCode)
      .query(`
        UPDATE GarbageTrucks
        SET weightKg = NULL
        WHERE truckCode = @truckCode
      `);

    await transaction.commit();
    res.json({ message: "✅ Đã thu hồi dữ liệu thành công." });
  } catch (err) {
    console.error("❌ Lỗi thu hồi dữ liệu:", err);
    res.status(500).json({ message: "Lỗi khi thu hồi dữ liệu." });
  }
});





app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
});
