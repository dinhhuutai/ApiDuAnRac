require('dotenv').config();
const express = require("express");
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { sql, poolPromise } = require("./db");
const bcrypt = require("bcrypt");
const { DateTime } = require('luxon');

// VAPID (ví dụ)
const webpush = require('web-push');
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,       // 'mailto:...'
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

require('./jobs/lunchReminderJob');

// Bật cron
require('./jobs/lunchToday11h25Job');
require('./jobs/lunchFeedback1150Job');

//Tạo task lặp hằng ngày;
require('./TaskManagement/cron/repeatDailyCron');


const uploadClassification = require('./middleware/uploadClassification');
const { signAccessToken, signRefreshToken, setRefreshCookie } = require('./utils/auth');

const cors = require("cors");
const jwt = require("jsonwebtoken");

const { apiInkWeighing } = require('./InkWeighing/api');
const { apiFeedback } = require('./Feedback/api');
const { apiSuggestion } = require('./Suggestion/api');
const { apiUtilsConvert } = require('./UtilsConvert/api');
const { apiLunchOrder } = require('./LunchOrder/api');
const { apiPayrollCalculation } = require('./PayrollCalculation/api');
const { apiForm } = require('./Form/api');
const { apiDryingCart } = require('./DryingCart/api');

const { webPushLunchOrder } = require('./WebPush/pushRoutes');

const { requireAuth } = require('./middleware/auth');


const SECRET = "Tai31072002@";

const app = express();
const port = process.env.PORT || 5000;

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || "D:/uploads";

app.use(express.json());
app.use(
  "/uploads",
  express.static(UPLOAD_ROOT, {
    index: false,
    maxAge: "7d",
  })
);


app.use(cors({
  origin: [
    'https://master.d3q09n8s04589q.amplifyapp.com',
    'https://master.d3q09n8s04589q.amplifyapp.com/login',
    'http://localhost:3000',
    'http://171.237.176.73:3000',
    'http://10.84.40.34:3000',
    'https://noibo.thuanhunglongan.com',
    'http://noibo.thuanhunglongan.com',
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
apiLunchOrder(app);
webPushLunchOrder(app);
apiPayrollCalculation(app);
apiForm(app);
apiDryingCart(app);


app.use('/api/task-management', require('./TaskManagement/api'));
app.use('/api/presence', require('./presence/api'));
app.use('/pageview', require('./pageviewRouter/api'));
app.use('/api/ink-coverage', require('./InkCoveragePercentOnFilm/api'));
//app.use('/api/quality-inspection', require('./QualityInspection/api'));

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

app.get('/api/lucky-gift/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userID;

    const pool = await poolPromise;
    const r = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`
        SELECT luckyGiftClaimed
        FROM dbo.Users
        WHERE userID = @userId
      `);

    const row = r.recordset[0];
    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy user',
      });
    }

    const claimed = !!row.luckyGiftClaimed;

    return res.json({
      success: true,
      data: {
        luckyGiftClaimed: claimed,
        canSpin: !claimed,
      },
    });
  } catch (err) {
    console.error('GET /api/lucky-gift/status error:', err);
    return res.status(500).json({
      success: false,
      message: 'Lỗi lấy trạng thái quà may mắn',
    });
  }
});

app.post('/api/lucky-gift/claim', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userID;
    const { prizeKey } = req.body || {}; // dùng để log FE nếu cần

    const pool = await poolPromise;

    // kiểm tra đã nhận thưởng chưa
    const check = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`
        SELECT luckyGiftClaimed
        FROM dbo.Users
        WHERE userID = @userId
      `);

    const row = check.recordset[0];
    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy user',
      });
    }

    if (row.luckyGiftClaimed) {
      return res.status(400).json({
        success: false,
        message: 'Bạn đã tham gia quay quà rồi',
      });
    }

    // cập nhật đã nhận thưởng
    await pool.request()
      .input('userId', sql.Int, userId)
      .query(`
        UPDATE dbo.Users
        SET luckyGiftClaimed = 1
        WHERE userID = @userId
      `);

    const FINAL_RESULT = 'Chúc bạn may mắn lần sau';

    return res.json({
      success: true,
      message: 'Nhận quà “thần may mắn” thành công',
      data: {
        luckyGiftResult: FINAL_RESULT, // chỉ trả về, KHÔNG lưu DB
        prizeKey,
      },
    });
  } catch (err) {
    console.error('POST /api/lucky-gift/claim error:', err);
    return res.status(500).json({
      success: false,
      message: 'Lỗi xác nhận quà may mắn',
    });
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

DECLARE @nowVN DATETIME =
  CONVERT(DATETIME, SYSDATETIMEOFFSET() AT TIME ZONE 'SE Asia Standard Time');

INSERT INTO TrashWeighings (
  trashBinCode, userID, weighingTime, weightKg, workShift,
  updatedAt, updatedBy, workDate, userName
)
OUTPUT INSERTED.weighingID INTO @output
VALUES (
  @trashBinCode, @userID, @nowVN, @weightKg, @workShift,
  @nowVN, @updatedBy, @workDate, @userName
);

SELECT weighingID FROM @output;
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

// app.put("/trash-weighings/:id", async (req, res) => {
//   const { id } = req.params;

//   const {
//     weightKg,
//     workShift,
//     workDate,
//     userName,
//     updatedAt,
//     updatedBy,
//   } = req.body;
  
//   const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

//   try {
//     const pool = await poolPromise;
//     const result = await pool.request()
//       .input("weighingID", sql.Int, id)
//       .input("weightKg", sql.Float, weightKg)
//       .input("workShift", sql.NVarChar, workShift)
//       .input("workDate", sql.Date, workDate)
//       .input("userName", sql.NVarChar, userName)
//       .input("updatedAt", sql.DateTime, nowVN)
//       .input("updatedBy", sql.Int, updatedBy)
//       .query(`
//         UPDATE TrashWeighings
//         SET
//           weightKg = @weightKg,
//           workShift = @workShift,
//           workDate = @workDate,
//           userName = @userName,
//           updatedAt = @updatedAt,
//           updatedBy = @updatedBy
//         WHERE weighingID = @weighingID
//       `);

//     if (result.rowsAffected[0] === 0) {
//       return res.status(404).send("❌ Không tìm thấy bản ghi để cập nhật");
//     }

//     res.send("✅ Đã cập nhật bản ghi cân rác");
//   } catch (err) {
//     console.log(err);
//     res.status(500).send("❌ Lỗi khi cập nhật dữ liệu");
//   }
// });

app.put("/trash-weighings/:id", async (req, res) => {
  const { id } = req.params;
  const { weightKg, workShift, workDate, userName, updatedBy } = req.body;

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input("weighingID", sql.Int, id)
      .input("weightKg", sql.Float, weightKg)
      .input("workShift", sql.NVarChar, workShift || null)
      .input("workDate", sql.Date, workDate || null)
      .input("userName", sql.NVarChar, userName || null)
      .input("updatedAt", sql.DateTime2, new Date())   // server time
      .input("updatedBy", sql.Int, updatedBy || null)
      .query(`
        UPDATE dbo.TrashWeighings
        SET weightKg = @weightKg,
            workShift = @workShift,
            workDate = @workDate,
            userName = @userName,
            updatedAt = @updatedAt,
            updatedBy = @updatedBy
        WHERE weighingID = @weighingID;
      `);

    if ((result.rowsAffected?.[0] || 0) === 0) {
      return res.status(404).send("❌ Không tìm thấy bản ghi để cập nhật");
    }
    res.send("✅ Đã cập nhật bản ghi cân rác");
  } catch (err) {
    console.log(err);
    res.status(500).send("❌ Lỗi khi cập nhật dữ liệu");
  }
});



// app.get("/history/date", async (req, res) => {
//   const { date } = req.query;

//   try {
//     const pool = await poolPromise;
//     const result = await pool.request()
//       .input("date", sql.DateTime, new Date(date))
//       .query(`
//         SELECT
//           U.fullName,
//           D.departmentName,
//           UN.unitName,
//           T.trashName,
//           B.trashBinCode,
//           W.weighingID,
//           W.weighingTime,
//           W.weightKg,
//           W.workDate,
//           W.workShift,
//           W.userName
//         FROM TrashWeighings W
//         JOIN Users U ON W.userID = U.userID        -- Thêm join với bảng Users để lấy tên người cân
//         JOIN TrashBins B ON W.trashBinCode = B.trashBinCode
//         JOIN Departments D ON B.departmentID = D.departmentID
//         LEFT JOIN Units UN ON B.unitID = UN.unitID
//         JOIN TrashTypes T ON B.trashTypeID = T.trashTypeID
//         WHERE CAST(W.weighingTime AS DATE) = CAST(@date AS DATE)
//         ORDER BY W.weighingTime DESC
//       `);

//     res.json(result.recordset);
//   } catch (err) {
//     console.log(err);
//     res.status(500).send("❌ Lỗi khi truy vấn dữ liệu");
//   }
// });

// /history/date (mới)
app.get("/history/date", async (req, res) => {
  try {
    const {
      date,
      page = 1,
      pageSize = 30,
      userName = '',
      departmentName = '',
      unitName = '',
      trashName = '',
      workShift = '',
      timeFrom = '',
      timeTo = '',
      disposalDate = '',
    } = req.query;

    if (!date) return res.status(400).json({ message: 'Thiếu date' });

    const _page = Math.max(1, parseInt(page, 10) || 1);
    const _pageSize = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 30));
    const offset = (_page - 1) * _pageSize;

    const startDate = new Date(`${date}T00:00:00.000Z`);
    const endDate   = new Date(`${date}T00:00:00.000Z`); endDate.setUTCDate(endDate.getUTCDate() + 1);

    const timeFromISO = timeFrom ? `${date}T${timeFrom}:00.000Z` : null;
    const timeToISO   = timeTo   ? `${date}T${timeTo}:59.999Z` : null;

    const pool = await poolPromise;
    const reqSql = pool.request()
      .input('startDate', sql.DateTime2, startDate)
      .input('endDate',   sql.DateTime2, endDate)
      .input('userName', sql.NVarChar, userName)
      .input('departmentName', sql.NVarChar, departmentName)
      .input('unitName', sql.NVarChar, unitName)
      .input('trashName', sql.NVarChar, trashName)
      .input('workShift', sql.NVarChar, workShift || null)
      .input('timeFrom',  sql.DateTime2, timeFromISO ? new Date(timeFromISO) : null)
      .input('timeTo',    sql.DateTime2, timeToISO ? new Date(timeToISO) : null)
      .input('disposalDate', sql.Date, disposalDate || null)
      .input('offset', sql.Int, offset)
      .input('fetch', sql.Int, _pageSize);

    const q = `
IF OBJECT_ID('tempdb..#BaseAll') IS NOT NULL DROP TABLE #BaseAll;
IF OBJECT_ID('tempdb..#BaseFiltered') IS NOT NULL DROP TABLE #BaseFiltered;

-- 1) Dữ liệu toàn ngày (chỉ date/time range/disposalDate) -> cho dropdown
SELECT
  W.weighingID,
  W.weighingTime,
  W.weightKg,
  W.workDate,
  W.workShift,
  W.userName,
  U.fullName,
  D.departmentName,
  UN.unitName,
  T.trashName,
  B.trashBinCode
INTO #BaseAll
FROM dbo.TrashWeighings W
JOIN dbo.TrashBins B ON W.trashBinCode = B.trashBinCode
JOIN dbo.Users U ON W.userID = U.userID
JOIN dbo.Departments D ON B.departmentID = D.departmentID
LEFT JOIN dbo.Units UN ON B.unitID = UN.unitID
JOIN dbo.TrashTypes T ON B.trashTypeID = T.trashTypeID
WHERE
  W.weighingTime >= @startDate AND W.weighingTime < @endDate
  AND (@timeFrom IS NULL OR W.weighingTime >= @timeFrom)
  AND (@timeTo   IS NULL OR W.weighingTime <= @timeTo)
  AND (@disposalDate IS NULL OR W.workDate = @disposalDate);

-- 2) Dữ liệu đã lọc theo tất cả filter -> cho bảng + totals
SELECT *
INTO #BaseFiltered
FROM #BaseAll
WHERE
  (@userName = N'' OR userName LIKE N'%'+@userName+N'%')
  AND (@departmentName = N'' OR departmentName LIKE N'%'+@departmentName+N'%')
  AND (@unitName = N'' OR unitName LIKE N'%'+@unitName+N'%')
  AND (@trashName = N'' OR trashName LIKE N'%'+@trashName+N'%')
  AND (@workShift IS NULL OR workShift = @workShift);

-- 3) totals (từ filtered)
SELECT COUNT(1) AS total, COALESCE(SUM(weightKg),0) AS totalWeight
FROM #BaseFiltered;

-- 4) items (trang hiện tại, từ filtered)
SELECT *
FROM #BaseFiltered
ORDER BY weighingTime DESC
OFFSET @offset ROWS FETCH NEXT @fetch ROWS ONLY;

-- 5) distincts (từ toàn ngày #BaseAll) -> KHÔNG bị teo theo filter
SELECT DISTINCT userName       FROM #BaseAll WHERE userName       IS NOT NULL ORDER BY userName;
SELECT DISTINCT departmentName FROM #BaseAll WHERE departmentName IS NOT NULL ORDER BY departmentName;
SELECT DISTINCT unitName       FROM #BaseAll WHERE unitName       IS NOT NULL ORDER BY unitName;
SELECT DISTINCT trashName      FROM #BaseAll WHERE trashName      IS NOT NULL ORDER BY trashName;
SELECT DISTINCT workShift      FROM #BaseAll WHERE workShift      IS NOT NULL ORDER BY workShift;

DROP TABLE #BaseFiltered;
DROP TABLE #BaseAll;
`;

    const result = await reqSql.query(q);

    const totals = result.recordsets?.[0]?.[0] || { total: 0, totalWeight: 0 };
const items  = result.recordsets?.[1] ?? [];

const dropdowns = {
  userNames:       (result.recordsets?.[2] || []).map(r => r.userName),
  departmentNames: (result.recordsets?.[3] || []).map(r => r.departmentName),
  unitNames:       (result.recordsets?.[4] || []).map(r => r.unitName),
  trashNames:      (result.recordsets?.[5] || []).map(r => r.trashName),
  workShifts:      (result.recordsets?.[6] || []).map(r => r.workShift),
};

res.json({
  items,
  total: totals.total ?? 0,
  totalWeight: Number(totals.totalWeight || 0),
  summary: { totalRows: totals.total ?? 0, totalWeight: Number(totals.totalWeight || 0) },
  page: _page, pageSize: _pageSize,
  dropdowns, // 👈 FE dùng cái này cho tất cả select
});

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '❌ Lỗi khi truy vấn dữ liệu' });
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


app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Thiếu username/password' });
  }

  try {
    const pool = await poolPromise;

    // Chỉ lấy các cột cần dùng
    const r = await pool.request()
      .input('username', sql.NVarChar, username)
      .query(`
        SELECT TOP 1
          userID, username, passwordHash, fullName, email, role, isActive, hasChangedPassword, firstLoginGiftClaimed
        FROM dbo.Users
        WHERE username = @username AND isActive = 1
      `);

    const u = r.recordset[0];
    if (!u) {
      return res.status(401).json({ success: false, message: 'Sai tài khoản hoặc mật khẩu' });
    }
    if (u.isActive === 0) {
      return res.status(401).json({ success: false, message: 'Tài khoản đang bị khóa' });
    }

    const ok = await bcrypt.compare(password, u.passwordHash || '');
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Sai tài khoản hoặc mật khẩu' });
    }

    // Payload tối giản cho access token
    const payload = {
      userID: u.userID,
      username: u.username,
      role: u.role,
      fullName: u.fullName,
      hasChangedPassword: u.hasChangedPassword,
      firstLoginGiftClaimed: u.firstLoginGiftClaimed,
    };

    const accessToken  = signAccessToken(payload);
    const refreshToken = signRefreshToken({ userID: u.userID });

    // Lưu refresh token vào DB để có thể revoke/rotate
    const expiresAt = new Date(Date.now() + 30*24*60*60*1000);
    await pool.request()
      .input('userID',   sql.Int,       u.userID)
      .input('token',    sql.NVarChar,  refreshToken)
      .input('expiresAt',sql.DateTime2, expiresAt)
      .query(`
        IF OBJECT_ID('dbo.RefreshTokens', 'U') IS NULL
        BEGIN
          CREATE TABLE dbo.RefreshTokens(
            id INT IDENTITY(1,1) PRIMARY KEY,
            userID INT NOT NULL,
            token NVARCHAR(512) NOT NULL,
            expiresAt DATETIME2 NOT NULL,
            createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
          );
          CREATE INDEX IX_RefreshTokens_userID ON dbo.RefreshTokens(userID);
          CREATE INDEX IX_RefreshTokens_token ON dbo.RefreshTokens(token);
        END;

        INSERT INTO dbo.RefreshTokens(userID, token, expiresAt)
        VALUES (@userID, @token, @expiresAt);
      `);

    // Gắn refreshToken vào cookie HTTP-only
    setRefreshCookie(res, refreshToken);

    // ⬇️ LẤY PERMISSIONS
    // 1) Module + role
    const rMods = await pool.request()
      .input('uid', sql.Int, u.userID)
      .query(`
        SELECT m.moduleId, m.name, um.role
        FROM dbo.UserModules um
        JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId = @uid
        ORDER BY m.moduleId
      `);
    const modules = rMods.recordset || [];

    // 2) Features + defaultAllowed + overridden + effectiveAllowed
    const rFeats = await pool.request()
      .input('uid', sql.Int, u.userID)
      .query(`
        ;WITH UM AS (
          SELECT um.userId, um.moduleId, um.role
          FROM dbo.UserModules um
          WHERE um.userId = @uid
        )
        SELECT
          f.moduleId,
          f.featureId,
          f.code,
          f.name,
          defaultAllowed = CASE UM.role
            WHEN 'admin' THEN CAST(f.defaultForAdmin AS bit)
            WHEN 'user'  THEN CAST(f.defaultForUser  AS bit)
            ELSE CAST(0 AS bit) END,
          overridden = g.isAllowed,
          effectiveAllowed = COALESCE(g.isAllowed, CASE UM.role
            WHEN 'admin' THEN CAST(f.defaultForAdmin AS bit)
            WHEN 'user'  THEN CAST(f.defaultForUser  AS bit)
            ELSE CAST(0 AS bit) END)
        FROM dbo.ModuleFeatures f
        JOIN UM ON UM.moduleId = f.moduleId
        LEFT JOIN dbo.UserModuleFeatureGrants g
          ON g.userId = UM.userId AND g.moduleId = f.moduleId AND g.featureId = f.featureId
        ORDER BY f.moduleId, f.featureId
      `);

    // group by moduleId
    const featuresByModule = {};
    for (const row of (rFeats.recordset || [])) {
      if (!featuresByModule[row.moduleId]) featuresByModule[row.moduleId] = [];
      featuresByModule[row.moduleId].push({
        featureId: row.featureId,
        code: row.code,
        name: row.name,
        defaultAllowed: row.defaultAllowed,
        overridden: row.overridden,          // null | bit
        effectiveAllowed: row.effectiveAllowed
      });
    }

    const permissions = { modules, featuresByModule };

    // Trả user + accessToken qua body
    return res.json({
      success: true,
      data: {
        accessToken,
        user: {
          userID: u.userID,
          username: u.username,
          fullName: u.fullName,
          email: u.email,
          role: u.role,
          hasChangedPassword: u.hasChangedPassword,
          firstLoginGiftClaimed: u.firstLoginGiftClaimed,
        },
        permissions // ⬅️ TRẢ KÈM QUYỀN
      },
    });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/change-password-first-login', requireAuth, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Mật khẩu mới phải từ 6 ký tự trở lên',
      });
    }

    const pool = await poolPromise;

    // kiểm tra user & trạng thái hiện tại
    const rUser = await pool.request()
      .input('userID', sql.Int, req.user.userID)
      .query(`
        SELECT hasChangedPassword
        FROM dbo.Users
        WHERE userID=@userID AND ISNULL(isDeleted,0)=0;
      `);

    if (!rUser.recordset.length) {
      return res.status(404).json({ success: false, message: 'User không tồn tại' });
    }

    const hasChangedPassword = !!rUser.recordset[0].hasChangedPassword;
    if (hasChangedPassword) {
      // đã đổi rồi thì không cần bắt nữa (phòng trường hợp call lại)
      return res.json({
        success: true,
        data: { skipped: true },
        message: 'Bạn đã đổi mật khẩu trước đó rồi',
      });
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await pool.request()
      .input('userID', sql.Int, req.user.userID)
      .input('passwordHash', sql.NVarChar, hash)
      .query(`
        UPDATE dbo.Users
        SET passwordHash = @passwordHash,
            hasChangedPassword = 1,
            updatedAt = SYSDATETIME()
        WHERE userID=@userID;
      `);

    return res.json({ success: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    console.error('POST /api/auth/change-password-first-login error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// cần requireAuth như các API auth khác
app.post('/api/auth/first-login-gift-claim', requireAuth, async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('userID', sql.Int, req.user.userID)
      .query(`
        UPDATE dbo.Users
        SET firstLoginGiftClaimed = 1,
            updatedAt = SYSDATETIME()
        WHERE userID = @userID AND ISNULL(isDeleted,0)=0;
      `);

    return res.json({ success: true, message: 'Đã đánh dấu nhận quà lần đầu đăng nhập.' });
  } catch (err) {
    console.error('POST /api/auth/first-login-gift-claim error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Yêu cầu middleware xác thực gắn req.user.userID từ accessToken
app.get('/api/me/permissions', requireAuth, async (req, res) => {
  try {

    const uid = req.user.userID;
    const pool = await poolPromise;

    const rMods = await pool.request()
      .input('uid', sql.Int, uid)
      .query(`
        SELECT m.moduleId, m.name, um.role
        FROM dbo.UserModules um
        JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId = @uid
        ORDER BY m.moduleId
      `);
    const modules = rMods.recordset || [];

    const rFeats = await pool.request()
      .input('uid', sql.Int, uid)
      .query(`
        ;WITH UM AS (
          SELECT um.userId, um.moduleId, um.role
          FROM dbo.UserModules um
          WHERE um.userId = @uid
        )
        SELECT
          f.moduleId, f.featureId, f.code, f.name,
          defaultAllowed = CASE UM.role
            WHEN 'admin' THEN CAST(f.defaultForAdmin AS bit)
            WHEN 'user'  THEN CAST(f.defaultForUser  AS bit)
            ELSE CAST(0 AS bit) END,
          overridden = g.isAllowed,
          effectiveAllowed = COALESCE(g.isAllowed, CASE UM.role
            WHEN 'admin' THEN CAST(f.defaultForAdmin AS bit)
            WHEN 'user'  THEN CAST(f.defaultForUser  AS bit)
            ELSE CAST(0 AS bit) END)
        FROM dbo.ModuleFeatures f
        JOIN UM ON UM.moduleId = f.moduleId
        LEFT JOIN dbo.UserModuleFeatureGrants g
          ON g.userId = UM.userId AND g.moduleId = f.moduleId AND g.featureId = f.featureId
        ORDER BY f.moduleId, f.featureId
      `);

    const featuresByModule = {};
    for (const row of (rFeats.recordset || [])) {
      if (!featuresByModule[row.moduleId]) featuresByModule[row.moduleId] = [];
      featuresByModule[row.moduleId].push({
        featureId: row.featureId,
        code: row.code,
        name: row.name,
        defaultAllowed: row.defaultAllowed,
        overridden: row.overridden,
        effectiveAllowed: row.effectiveAllowed
      });
    }

    return res.json({ success: true, data: { modules, featuresByModule } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});



// app.post("/user", async (req, res) => {
//   const { username, password, fullName, phone, role, createdBy, operationType, roleEditReport, actionHistoryWeigh, managerQRcode, managerUser, managerTrash, managerTeamMember, managerFeedback } = req.body;
//   try {
//     const pool = await poolPromise;

//     // ✅ Kiểm tra username đã tồn tại chưa
//     const check = await pool.request()
//       .input("username", sql.NVarChar, username)
//       .query("SELECT * FROM Users WHERE username = @username");

//     if (check.recordset.length > 0) {
//       return res.status(400).send("❌ Username đã tồn tại");
//     }

//     // ✅ Nếu chưa có thì hash mật khẩu và thêm user
//     const hash = await bcrypt.hash(password, 10);
//     const now = new Date();

//     const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

//     await pool.request()
//       .input("username", sql.NVarChar, username)
//       .input("passwordHash", sql.NVarChar, hash)
//       .input("fullName", sql.NVarChar, fullName)
//       .input("phone", sql.NVarChar, phone)
//       .input("role", sql.NVarChar, role)
//       .input("isActive", sql.Bit, 1)
//       .input("createdBy", sql.Int, createdBy)
//       .input("createdAt", sql.DateTime, nowVN)
//       .input("operationType", sql.NVarChar, operationType)
//       .input("roleEditReport", sql.Bit, roleEditReport)
//       .input("actionHistoryWeigh", sql.Bit, actionHistoryWeigh)
//       .input("managerQRcode", sql.Bit, managerQRcode)
//       .input("managerUser", sql.Bit, managerUser)
//       .input("managerTrash", sql.Bit, managerTrash)
//       .input("managerTeamMember", sql.Bit, managerTeamMember)
//       .input("managerFeedback", sql.Bit, managerFeedback)
//       .query(`
//         INSERT INTO Users (username, passwordHash, fullName, phone, role, isActive, createdBy, createdAt, operationType, roleEditReport, actionHistoryWeigh, managerQRcode, managerUser, managerTrash, managerTeamMember, managerFeedback)
//         VALUES (@username, @passwordHash, @fullName, @phone, @role, @isActive, @createdBy, @createdAt, @operationType, @roleEditReport, @actionHistoryWeigh, @managerQRcode, @managerUser, @managerTrash, @managerTeamMember, @managerFeedback)
//       `);

//     res.send("✅ Đã thêm tài khoản");
//   } catch (err) {
//     console.log(err);
//     res.status(500).send("❌ Lỗi tạo tài khoản");
//   }
// });

// chỉ lấy các cột cần thiết
const mapUser = (r) => ({
  userID: r.userID,
  username: r.username,
  fullName: r.fullName,
  email: r.email,
  phone: r.phone,
  role: r.role,
  isActive: r.isActive,
  lastLogin: r.lastLogin,
  createdAt: r.createdAt,
  avatar: r.avatar,
});

// GET /api/users?q=&page=&pageSize=&includeModules=1
app.get('/api/users', async (req, res) => {
  const { q = '', page = 1, pageSize = 20, includeModules } = req.query;
  const _page = Math.max(1, parseInt(page, 10) || 1);
  const _size = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 20));
  const offset = (_page - 1) * _size;
  const qLike = `%${q}%`;

  try {
    const pool = await poolPromise;

    const rCount = await pool.request()
      .input('q', sql.NVarChar, qLike)
      .query(`
        SELECT COUNT(*) AS total
        FROM dbo.Users u
        WHERE (@q='%%' OR u.username LIKE @q OR u.fullName LIKE @q OR u.email LIKE @q OR u.phone LIKE @q)
      `);
    const total = rCount.recordset[0]?.total || 0;

    const rData = await pool.request()
      .input('q', sql.NVarChar, qLike)
      .input('size', sql.Int, _size)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT
          u.userID, u.username, u.fullName, u.email, u.phone,
          u.role, u.isActive, u.lastLogin, u.createdAt, u.avatar
        FROM dbo.Users u
        WHERE (@q='%%' OR u.username LIKE @q OR u.fullName LIKE @q OR u.email LIKE @q OR u.phone LIKE @q)
        ORDER BY u.userID DESC
        OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
      `);

    const users = rData.recordset.map(mapUser);

    // includeModules=1 -> trả kèm modules assigned (role != NULL)
    if (parseInt(includeModules, 10) === 1 && users.length > 0) {
      const ids = users.map(u => Number(u.userID)).filter(Number.isInteger);
      const idList = ids.join(','); // integer-only (đã filter)

      const rMods = await pool.request().query(`
        SELECT um.userId, um.moduleId, um.role, m.name
        FROM dbo.UserModules um
        INNER JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId IN (${idList})
      `);

      const byUser = {};
      for (const row of rMods.recordset) {
        if (!byUser[row.userId]) byUser[row.userId] = [];
        byUser[row.userId].push({
          moduleId: row.moduleId,
          name: row.name,
          role: row.role, // 'admin'/'user'
        });
      }
      users.forEach(u => { u.modules = byUser[u.userID] || []; });
    }

    return res.json({ success: true, data: users, pagination: { page: _page, pageSize: _size, total } });
  } catch (err) {
    console.error('GET /api/users error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/users  (tạo mới, pass mặc định = "1")
app.post('/api/users', async (req, res) => {
  try {
    const { username, fullName, email = null, phone = null, role = 'user', isActive = true } = req.body || {};
    if (!username || !fullName) {
      return res.status(400).json({ success: false, message: 'Thiếu username/fullName' });
    }
    const pool = await poolPromise;

    // check trùng username
    const rU = await pool.request()
      .input('username', sql.NVarChar, username)
      .query(`SELECT TOP 1 userID FROM dbo.Users WHERE username=@username`);
    if (rU.recordset.length) {
      return res.status(400).json({ success: false, message: 'Username đã tồn tại' });
    }

    // hash mật khẩu mặc định "1"
    const hash = await bcrypt.hash('1', 10);

    const rIns = await pool.request()
      .input('username', sql.NVarChar, username)
      .input('passwordHash', sql.NVarChar, hash)
      .input('fullName', sql.NVarChar, fullName)
      .input('email', sql.NVarChar, email)
      .input('phone', sql.NVarChar, phone)
      .input('role', sql.NVarChar, role === 'admin' ? 'admin' : 'user')
      .input('isActive', sql.Bit, !!isActive)
      .input('msnv', sql.NVarChar, username)
      .input('hasChangedPassword', sql.Bit, 0)
      .input('luckyGiftClaimed', sql.Bit, 1)
      .input('firstLoginGiftClaimed', sql.Bit, 0)
      .query(`
        INSERT INTO dbo.Users (username, passwordHash, fullName, email, phone, role, isActive, msnv, createdAt, hasChangedPassword, luckyGiftClaimed, firstLoginGiftClaimed)
        VALUES (@username, @passwordHash, @fullName, @email, @phone, @role, @isActive, @msnv, SYSDATETIME(), @hasChangedPassword, @luckyGiftClaimed, @firstLoginGiftClaimed);
        SELECT SCOPE_IDENTITY() AS userID;
      `);

    const userID = rIns.recordset[0]?.userID;
    return res.json({ success: true, data: { userID } });
  } catch (err) {
    console.error('POST /api/users error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/users/:userId  (cập nhật thông tin cơ bản)
app.put('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const _id = parseInt(userId, 10);
  if (!Number.isInteger(_id) || _id <= 0) return res.status(400).json({ success: false, message: 'userId không hợp lệ' });

  const { fullName, email, phone, role, isActive, avatar } = req.body || {};
  try {
    const pool = await poolPromise;
    await pool.request()
      .input('userID', sql.Int, _id)
      .input('fullName', sql.NVarChar, fullName ?? null)
      .input('email', sql.NVarChar, email ?? null)
      .input('phone', sql.NVarChar, phone ?? null)
      .input('role', sql.NVarChar, role === 'admin' ? 'admin' : 'user')
      .input('isActive', sql.Bit, typeof isActive === 'boolean' ? isActive : null)
      .input('avatar', sql.NVarChar, avatar ?? null)
      .query(`
        UPDATE dbo.Users
        SET
          fullName = ISNULL(@fullName, fullName),
          email    = CASE WHEN @email IS NULL THEN email ELSE @email END,
          phone    = CASE WHEN @phone IS NULL THEN phone ELSE @phone END,
          role     = CASE WHEN @role IS NULL THEN role ELSE @role END,
          isActive = COALESCE(@isActive, isActive),
          avatar   = COALESCE(@avatar, avatar),
          updatedAt = SYSDATETIME()
        WHERE userID = @userID
      `);
    return res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/users/:userId error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/users/:userId/active  (bật/tắt)
app.put('/api/users/:userId/active', async (req, res) => {
  const { userId } = req.params;
  const _id = parseInt(userId, 10);
  const { isActive } = req.body || {};
  if (!Number.isInteger(_id)) return res.status(400).json({ success: false, message: 'userId không hợp lệ' });

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('userID', sql.Int, _id)
      .input('isActive', sql.Bit, !!isActive)
      .query(`UPDATE dbo.Users SET isActive=@isActive, updatedAt=SYSDATETIME() WHERE userID=@userID`);
    return res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/users/:userId/active error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/users/:userId/reset-password  (đặt về "1")
app.post('/api/users/:userId/reset-password', async (req, res) => {
  const { userId } = req.params;
  const _id = parseInt(userId, 10);
  if (!Number.isInteger(_id)) return res.status(400).json({ success: false, message: 'userId không hợp lệ' });
  try {
    const hash = await bcrypt.hash('1', 10);
    const pool = await poolPromise;
    await pool.request()
      .input('userID', sql.Int, _id)
      .input('passwordHash', sql.NVarChar, hash)
      .query(`UPDATE dbo.Users SET passwordHash=@passwordHash, updatedAt=SYSDATETIME() WHERE userID=@userID`);
    return res.json({ success: true });
  } catch (err) {
    console.error('POST /api/users/:userId/reset-password error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/users/:userId/modules-roles  (CHỈ module đã được phân quyền)
app.get('/api/users/:userId/modules-roles', async (req, res) => {
  const { userId } = req.params;
  const _id = parseInt(userId, 10);
  const { q = '', page = 1, pageSize = 100 } = req.query;

  if (!Number.isInteger(_id) || _id <= 0) {
    return res.status(400).json({ success: false, message: 'userId không hợp lệ' });
  }
  const _page = Math.max(1, parseInt(page, 10) || 1);
  const _size = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 100));
  const offset = (_page - 1) * _size;
  const qLike = `%${q}%`;

  try {
    const pool = await poolPromise;

    const rCount = await pool.request()
      .input('userId', sql.Int, _id)
      .input('q', sql.NVarChar, qLike)
      .query(`
        SELECT COUNT(*) AS total
        FROM dbo.UserModules um
        INNER JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId=@userId
          AND (@q='%%' OR m.name LIKE @q OR m.description LIKE @q)
      `);
    const total = rCount.recordset[0]?.total || 0;

    const rData = await pool.request()
      .input('userId', sql.Int, _id)
      .input('q', sql.NVarChar, qLike)
      .input('size', sql.Int, _size)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT m.moduleId, m.name, m.icon, m.description, um.role
        FROM dbo.UserModules um
        INNER JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId=@userId
          AND (@q='%%' OR m.name LIKE @q OR m.description LIKE @q)
        ORDER BY m.moduleId ASC
        OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
      `);

    const data = rData.recordset.map(row => ({
      moduleId: row.moduleId,
      name: row.name,
      icon: row.icon,
      description: row.description,
      allowedRoles: row.role === 'admin' ? ['admin','user'] : row.role === 'user' ? ['user'] : [],
    }));

    return res.json({ success: true, data, pagination: { page: _page, pageSize: _size, total } });
  } catch (err) {
    console.error('GET /api/users/:userId/modules-roles error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put("/api/users/:userId/change-password", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { currentPassword, newPassword } = req.body;

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: "userId không hợp lệ" });
    }
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Thiếu mật khẩu." });
    }

    // Chỉ cho tự đổi (chính chủ) hoặc admin
    if (req.user.userID !== userId && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Không có quyền đổi mật khẩu người khác." });
    }

    const pool = await poolPromise;
    const r = await pool.request()
      .input("userID", sql.Int, userId)
      .query("SELECT TOP 1 userID, passwordHash FROM dbo.Users WHERE userID=@userID AND isActive=1");

    const u = r.recordset[0];
    if (!u) return res.status(404).json({ success: false, message: "Không tìm thấy user." });

    // Nếu admin đổi cho người khác: có thể bỏ qua check currentPassword (tuỳ policy)
    if (req.user.role !== "admin" || req.user.userID === userId) {
      const ok = await bcrypt.compare(currentPassword, u.passwordHash || "");
      if (!ok) return res.status(400).json({ success: false, message: "Mật khẩu hiện tại không đúng." });
    }

    const saltRounds = 12;
    const hash = await bcrypt.hash(newPassword, saltRounds);

    await pool.request()
      .input("userID", sql.Int, userId)
      .input("hash", sql.NVarChar, hash)
      .query(`
        UPDATE dbo.Users
        SET passwordHash=@hash, updatedAt=SYSDATETIME(), updatedBy=@userID
        WHERE userID=@userID
      `);

    // (khuyến nghị) Thu hồi refresh tokens cũ
    // await pool.request().input("userID", sql.Int, userId)
    //   .query("UPDATE dbo.RefreshTokens SET isRevoked=1 WHERE userID=@userID AND isRevoked=0");

    return res.json({ success: true });
  } catch (e) {
    console.error("change-password error", e);
    return res.status(500).json({ success: false, message: "Server error" });
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

// const TRASH_NAMES = [
//     'Giẻ lau có chứa thành phần nguy hại',
//     'Giẻ lau dính lapa',
//     'Băng keo dính mực',
//     'Keo bàn thải',
//     'Mực in thải',
//     'Mực in lapa thải',
//     'Vụn logo',
//     'Lụa căng khung',
//     'Rác sinh hoạt'
// ];
// const SHIFTS = ['ca1', 'ca2', 'ca3', 'dai1', 'dai2', 'cahc', null];

app.get('/api/statistics/weight-by-unit', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const pool = await poolPromise;

    // 26/08/2025
    const minCreatedDate = '2025-08-26';

    // Tạo cột pivot CASE WHEN cho từng loại rác & ca
    const pivotColumns = [];
    for (const trash of TRASH_NAMES) {
      for (const shift of SHIFTS) {
        const shiftLabel = shift === null ? 'IS NULL' : `= N'${shift}'`;
        const alias = `${trash.replace(/\s+/g, '')}_${shift || 'null'}`;
        pivotColumns.push(`
          SUM(CASE 
              WHEN tt.trashName = N'${trash}' AND tw.workShift ${shiftLabel}
              THEN tw.weightKg ELSE 0 
          END) AS [${alias}]
        `);
      }
    }

    const query = `
      SELECT 
          d.departmentName AS department,
          u.unitName       AS unit,
          ${pivotColumns.join(',')},
          SUM(tw.weightKg) AS totalWeight
      FROM TrashWeighings tw
      JOIN TrashBins tb       ON tw.trashBinCode = tb.trashBinCode
      JOIN TrashTypes tt      ON tb.trashTypeID  = tt.trashTypeID
      JOIN Departments d      ON tb.departmentID = d.departmentID
      -- chỉ lấy Unit có createdAt > @minCreatedDate
      INNER JOIN Units u      ON tb.unitID = u.unitID
      WHERE 
          (
            tw.workDate BETWEEN @startDate AND @endDate
            OR (tw.workDate IS NULL AND tw.weighingTime BETWEEN @startDate AND @endDate)
          )
          -- chỉ lấy Department & Unit tạo sau 26/08/2025
          -- AND d.createdAt > @minCreatedDate
          -- AND u.createdAt > @minCreatedDate
      GROUP BY d.departmentName, u.unitName
      ORDER BY d.departmentName, u.unitName
    `;

    const result = await pool.request()
      .input('startDate',      sql.Date,       startDate)
      .input('endDate',        sql.Date,       endDate)
      .input('minCreatedDate', sql.DateTime2,  minCreatedDate)
      .query(query);

    const finalResult = result.recordset.map(row => {
      const values = [];
      for (const trash of TRASH_NAMES) {
        for (const shift of SHIFTS) {
          const alias = `${trash.replace(/\s+/g, '')}_${shift || 'null'}`;
          values.push(Math.round((row[alias] || 0) * 100) / 100);
        }
      }
      values.push(Math.round((row.totalWeight || 0) * 100) / 100);

      return {
        d: row.department,
        u: row.unit,
        value: values
      };
    });

    res.json({ status: 'success', data: finalResult });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
// Thứ tự 6 ca + 1 slot null để chốt từng block 7 (giữ như FE đang dùng)
const SHIFTS = ['ca1', 'ca2', 'ca3', 'dai1', 'dai2', 'cahc', null];

function buildPivotColumns() {
  const cols = [];
  for (const trash of TRASH_NAMES) {
    const base = trash.replace(/\s+/g, '');
    for (const shift of SHIFTS) {
      const cond = shift === null ? 'IS NULL' : `= N'${shift}'`;
      const alias = `${base}_${shift || 'null'}`;
      cols.push(`
        SUM(CASE WHEN tt.trashName = N'${trash}' AND tw.workShift ${cond}
                 THEN tw.weightKg ELSE 0 END) AS [${alias}]
      `);
    }
  }
  return cols.join(',');
}

const cache = new Map();
function cacheKey({startDate, endDate, bucketName}) {
  return `${startDate}|${endDate}|${bucketName||''}`;
}
app.get('/api/statistics/weight-by-bucket', async (req, res) => {
  try {
    const { startDate, endDate, bucketName = '' } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ status: 'error', message: 'startDate/endDate required' });
    }

    const pool = await poolPromise;
    const pivotColumns = buildPivotColumns();

    
    const key = cacheKey({startDate, endDate, bucketName});
    const cached = cache.get(key);
    if (cached && Date.now() - cached.t < 30_000) {
      return res.json(cached.v);
    }

    // 1) Buckets + Units (danh sách hiển thị & thứ tự)
    const metaSql = `
      ;WITH B AS (
        SELECT b.bucketID, b.bucketName, b.departmentID, b.orderIndex
        FROM dbo.ReportBuckets b
        WHERE b.isActive = 1
          AND (@bucketName = N'' OR b.bucketName = @bucketName)
      )
      SELECT * FROM B ORDER BY orderIndex, bucketName;

      SELECT ub.bucketID, ub.unitID, ub.orderIndex AS unitOrder, u.unitName
      FROM dbo.UnitBucket ub
      JOIN dbo.Units u ON u.unitID = ub.unitID
      JOIN (SELECT * FROM dbo.ReportBuckets WHERE isActive = 1) b ON b.bucketID = ub.bucketID
      WHERE (@bucketName = N'' OR b.bucketName = @bucketName);
    `;
    const metaRs = await pool.request()
     .input('bucketName', sql.NVarChar, bucketName)
     .query(metaSql);
    const buckets = metaRs.recordsets[0] || [];
    const bucketUnits = metaRs.recordsets[1] || [];

    if (buckets.length === 0) {
      return res.json({ status: 'success', data: [], grandTotal: Array(64).fill(0) });
    }

    // 2) Khoảng thời gian: inclusive đến cuối ngày endDate
    const qData = `
SET NOCOUNT ON;

DECLARE @start date = @startDate;
DECLARE @end   date = @endDate;
DECLARE @endOfDay datetime2 = DATEADD(ms, -3, DATEADD(day, 1, CAST(@end AS datetime2)));

-- 1) Bucket filter (table variable)
DECLARE @B TABLE (
  bucketID     INT PRIMARY KEY,
  departmentID INT
);
INSERT INTO @B(bucketID, departmentID)
SELECT bucketID, departmentID
FROM dbo.ReportBuckets
WHERE isActive = 1
  AND (@bucketName = N'' OR bucketName = @bucketName);

IF NOT EXISTS (SELECT 1 FROM @B) BEGIN
  -- Không có bucket nào khớp -> trả rỗng
  SELECT CAST(0 AS INT) AS bucketID, CAST(0 AS INT) AS unitID, CAST(0 AS DECIMAL(18,2)) AS totalWeight WHERE 1=0;
  SELECT CAST(0 AS INT) AS bucketID, CAST(0 AS DECIMAL(18,2)) AS totalWeight WHERE 1=0;
  RETURN;
END

-- 2) TrashTypes cần lấy (chỉ 9 loại bạn đang dùng) -> đổ vào @TYPES để có ID
DECLARE @TYPES TABLE (trashTypeID INT PRIMARY KEY);
INSERT INTO @TYPES(trashTypeID)
SELECT tt.trashTypeID
FROM dbo.TrashTypes tt
WHERE tt.trashName IN (
  N'Giẻ lau có chứa thành phần nguy hại',
  N'Giẻ lau dính lapa',
  N'Băng keo dính mực',
  N'Keo bàn thải',
  N'Mực in thải',
  N'Mực in lapa thải',
  N'Vụn logo',
  N'Lụa căng khung',
  N'Rác sinh hoạt'
);

-- 3) Lọc TrashWeighings theo ngày -> đổ temp table (chỉ các cột cần)
IF OBJECT_ID('tempdb..#TW') IS NOT NULL DROP TABLE #TW;
SELECT
    tw.trashBinCode,
    tw.workDate,
    tw.weighingTime,
    tw.workShift,
    tw.weightKg
INTO #TW
FROM dbo.TrashWeighings tw
WHERE
      (tw.workDate IS NOT NULL AND tw.workDate BETWEEN @start AND @end)
   OR (tw.workDate IS NULL AND tw.weighingTime >= @start AND tw.weighingTime <= @endOfDay);

-- 4) Gom trước cho Unit đã gắn Bucket
;WITH AggUnit AS (
  SELECT
      ub.bucketID,
      u.unitID,
      tt.trashTypeID,
      tw.workShift,
      SUM(tw.weightKg) AS total
  FROM #TW tw
  JOIN dbo.TrashBins tb   ON tb.trashBinCode = tw.trashBinCode
  JOIN dbo.Units u        ON u.unitID = tb.unitID
  JOIN dbo.UnitBucket ub  ON ub.unitID = u.unitID
  JOIN @B B               ON B.bucketID = ub.bucketID
  JOIN dbo.TrashTypes tt  ON tt.trashTypeID = tb.trashTypeID
  JOIN @TYPES T           ON T.trashTypeID = tt.trashTypeID
  GROUP BY ub.bucketID, u.unitID, tt.trashTypeID, tw.workShift
)
SELECT
  AU.bucketID,
  AU.unitID,
  /* 63 cột pivot (9 trash × 7 ca) */
  ${TRASH_NAMES.map(name => {
    const base = name.replace(/\s+/g, '');
    return SHIFTS.map(shift => {
      const condShift = shift === null ? 'IS NULL' : `= N'${shift}'`;
      return `
      SUM(CASE WHEN ttNames.trashName = N'${name}' AND AU.workShift ${condShift} THEN AU.total ELSE 0 END) AS [${base}_${shift || 'null'}]`;
    }).join(',');
  }).join(',')}
  ,
  SUM(AU.total) AS totalWeight
FROM AggUnit AU
JOIN dbo.TrashTypes ttNames ON ttNames.trashTypeID = AU.trashTypeID
GROUP BY AU.bucketID, AU.unitID
ORDER BY AU.bucketID, AU.unitID;

-- 5) Orphan QR (không gắn Unit) -> gom trước theo bucket
;WITH AggOrphan AS (
  SELECT
      B.bucketID,
      tt.trashTypeID,
      tw.workShift,
      SUM(tw.weightKg) AS total
  FROM @B B
  JOIN dbo.TrashBins tb  ON tb.departmentID = B.departmentID
  JOIN #TW tw            ON tw.trashBinCode = tb.trashBinCode
  JOIN dbo.TrashTypes tt ON tt.trashTypeID = tb.trashTypeID
  JOIN @TYPES T          ON T.trashTypeID = tt.trashTypeID
  WHERE tb.unitID IS NULL
  GROUP BY B.bucketID, tt.trashTypeID, tw.workShift
)
SELECT
  AO.bucketID,
  ${TRASH_NAMES.map(name => {
    const base = name.replace(/\s+/g, '');
    return SHIFTS.map(shift => {
      const condShift = shift === null ? 'IS NULL' : `= N'${shift}'`;
      return `
  SUM(CASE WHEN ttNames.trashName = N'${name}' AND AO.workShift ${condShift} THEN AO.total ELSE 0 END) AS [${base}_${shift || 'null'}]`;
    }).join(',');
  }).join(',')}
  ,
  SUM(AO.total) AS totalWeight
FROM AggOrphan AO
JOIN dbo.TrashTypes ttNames ON ttNames.trashTypeID = AO.trashTypeID
GROUP BY AO.bucketID
ORDER BY AO.bucketID;

SET NOCOUNT OFF;
`;


    const dataRs = await pool.request()
      .input('startDate', sql.Date, startDate)
      .input('endDate',   sql.Date, endDate)
      .input('bucketName', sql.NVarChar, bucketName)
      .query(qData);

    // Map dữ liệu nặng
    const byUnit = new Map(); // key = `${bucketID}::${unitID}` → record weight
    for (const r of dataRs.recordsets[0] || []) {
      byUnit.set(`${r.bucketID}::${r.unitID}`, r);
    }
    const orphanByBucket = new Map(); // bucketID → record weight
    for (const r of dataRs.recordsets[1] || []) {
      orphanByBucket.set(r.bucketID, r);
    }

    // Helper: lấy vector 64 theo các alias
    function pack64(row) {
      const arr = [];
      for (const trash of TRASH_NAMES) {
        const base = trash.replace(/\s+/g, '');
        for (const shift of SHIFTS) {
          const alias = `${base}_${shift || 'null'}`;
          arr.push(Math.round(((row?.[alias] || 0) + Number.EPSILON) * 100) / 100);
        }
      }
      arr.push(Math.round(((row?.totalWeight || 0) + Number.EPSILON) * 100) / 100); // index 63
      return arr;
    }

    // Build payload: buckets → units (đúng thứ tự)
    const out = [];
    const grand = Array(64).fill(0);

    for (const b of buckets) {
      const units = bucketUnits
        .filter(u => u.bucketID === b.bucketID)
        .sort((a, z) => (a.unitOrder ?? 0) - (z.unitOrder ?? 0)
          || a.unitName.localeCompare(z.unitName, 'vi'));

      const uiUnits = [];
      let sumBucket = Array(64).fill(0);

      for (const u of units) {
        const rec = byUnit.get(`${b.bucketID}::${u.unitID}`);
        const values = pack64(rec);
        uiUnits.push({ unitID: u.unitID, unitName: u.unitName, value: values });

        // cộng dồn
        for (let i = 0; i < 64; i++) sumBucket[i] += values[i];
      }

      // orphan (QR cấp bộ phận)
      let orphan = null;
      const o = orphanByBucket.get(b.bucketID);
      if (o) {
        const ovals = pack64(o);
        orphan = { unitID: null, unitName: '(QR cấp bộ phận)', value: ovals };
        for (let i = 0; i < 64; i++) sumBucket[i] += ovals[i];
      }

      // cộng vào grand
      for (let i = 0; i < 64; i++) grand[i] += sumBucket[i];

      out.push({
        bucketID: b.bucketID,
        bucketName: b.bucketName,
        departmentID: b.departmentID,
        units: uiUnits,
        orphan,
        sum: sumBucket
      });
    }


    const payload = { status:'success', data: out, grandTotal: grand };
    cache.set(key, { t: Date.now(), v: payload });
    res.json(payload);
  } catch (e) {
    console.error('GET /api/statistics/weight-by-bucket error:', e);
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
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
        WHERE d.isActiveCheck = 1
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

//////////////////////////////////////////////////

app.post('/api/modules', async (req, res) => {
  const { name, moduleKey, icon = null, description = null } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'name is required' });
  }
  if (!moduleKey || !/^[a-z0-9-]{2,64}$/.test(moduleKey)) {
    return res.status(400).json({ success: false, message: 'moduleKey is invalid (a-z,0-9,-)' });
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // dup name
    const rqCheckName = new sql.Request(tx);
    const dupName = await rqCheckName
      .input('name', sql.NVarChar, name.trim())
      .query(`SELECT 1 FROM dbo.Modules WHERE name=@name`);
    if (dupName.recordset.length > 0) {
      await tx.rollback();
      return res.status(409).json({ success: false, message: 'Module name already exists' });
    }

    // dup moduleKey
    const rqCheckKey = new sql.Request(tx);
    const dupKey = await rqCheckKey
      .input('moduleKey', sql.NVarChar, moduleKey.trim())
      .query(`SELECT 1 FROM dbo.Modules WHERE moduleKey=@moduleKey`);
    if (dupKey.recordset.length > 0) {
      await tx.rollback();
      return res.status(409).json({ success: false, message: 'moduleKey already exists' });
    }

    // insert
    const rqIns = new sql.Request(tx);
    const r = await rqIns
      .input('name', sql.NVarChar, name.trim())
      .input('moduleKey', sql.NVarChar, moduleKey.trim())
      .input('icon', sql.NVarChar, icon)
      .input('description', sql.NVarChar, description)
      .query(`
        INSERT INTO dbo.Modules(name, moduleKey, icon, description)
        OUTPUT INSERTED.moduleId, INSERTED.name, INSERTED.moduleKey, INSERTED.icon, INSERTED.description
        VALUES(@name, @moduleKey, @icon, @description)
      `);

    await tx.commit();
    return res.status(201).json({ success: true, data: r.recordset[0] });
  } catch (err) {
    console.error('❌ Create module error:', err);
    try { await tx.rollback(); } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});



app.put('/api/modules/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, moduleKey, icon = null, description = null } = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'name is required' });
  }
  if (!moduleKey || !/^[a-z0-9-]{2,64}$/.test(moduleKey)) {
    return res.status(400).json({ success: false, message: 'moduleKey is invalid (a-z,0-9,-)' });
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // exist?
    const rqExist = new sql.Request(tx);
    const existed = await rqExist
      .input('id', sql.Int, id)
      .query(`SELECT 1 FROM dbo.Modules WHERE moduleId=@id`);
    if (existed.recordset.length === 0) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    // dup name (khác id)
    const rqDupName = new sql.Request(tx);
    const dupName = await rqDupName
      .input('id', sql.Int, id)
      .input('name', sql.NVarChar, name.trim())
      .query(`SELECT 1 FROM dbo.Modules WHERE name=@name AND moduleId<>@id`);
    if (dupName.recordset.length > 0) {
      await tx.rollback();
      return res.status(409).json({ success: false, message: 'Module name already exists' });
    }

    // dup key (khác id)
    const rqDupKey = new sql.Request(tx);
    const dupKey = await rqDupKey
      .input('id', sql.Int, id)
      .input('moduleKey', sql.NVarChar, moduleKey.trim())
      .query(`SELECT 1 FROM dbo.Modules WHERE moduleKey=@moduleKey AND moduleId<>@id`);
    if (dupKey.recordset.length > 0) {
      await tx.rollback();
      return res.status(409).json({ success: false, message: 'moduleKey already exists' });
    }

    // update
    const rqUpd = new sql.Request(tx);
    const r = await rqUpd
      .input('id', sql.Int, id)
      .input('name', sql.NVarChar, name.trim())
      .input('moduleKey', sql.NVarChar, moduleKey.trim())
      .input('icon', sql.NVarChar, icon)
      .input('description', sql.NVarChar, description)
      .query(`
        UPDATE dbo.Modules
        SET name=@name, moduleKey=@moduleKey, icon=@icon, description=@description
        OUTPUT INSERTED.moduleId, INSERTED.name, INSERTED.moduleKey, INSERTED.icon, INSERTED.description
        WHERE moduleId=@id
      `);

    await tx.commit();
    return res.json({ success: true, data: r.recordset[0] });
  } catch (err) {
    console.error('❌ Update module error:', err);
    try { await tx.rollback(); } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});



app.delete('/api/modules/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // (Tuỳ chọn) Nếu có bảng phụ tham chiếu đến Modules thì xoá/clear trước ở đây
    // ví dụ: UserModules … (không có trong schema hiện tại)

    const rqDel = new sql.Request(tx);
    const r = await rqDel
      .input('id', sql.Int, id)
      .query(`
        DELETE FROM dbo.Modules
        OUTPUT DELETED.moduleId
        WHERE moduleId=@id
      `);

    if (r.recordset.length === 0) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    await tx.commit();
    return res.json({ success: true, data: { moduleId: id } });
  } catch (err) {
    console.error('❌ Delete module error:', err);
    try { await tx.rollback(); } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/modules', async (req, res) => {
  const { q = '', page = 1, pageSize = 10 } = req.query;
  const _page = Math.max(1, parseInt(page, 10) || 1);
  const _size = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 10));
  const offset = (_page - 1) * _size;

  try {
    const pool = await poolPromise;

    const rCount = await pool.request()
      .input('q', sql.NVarChar, `%${q}%`)
      .query(`
        SELECT COUNT(*) AS total
        FROM dbo.Modules
        WHERE (@q = '%%' OR name LIKE @q OR description LIKE @q OR moduleKey LIKE @q)
      `);
    const total = rCount.recordset[0]?.total || 0;

    const rData = await pool.request()
      .input('q', sql.NVarChar, `%${q}%`)
      .input('size', sql.Int, _size)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT moduleId, name, moduleKey, icon, description
        FROM dbo.Modules
        WHERE (@q = '%%' OR name LIKE @q OR description LIKE @q OR moduleKey LIKE @q)
        ORDER BY moduleId ASC
        OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
      `);

    return res.json({
      success: true,
      data: rData.recordset,
      pagination: { page: _page, pageSize: _size, total },
    });
  } catch (err) {
    console.error('❌ List modules error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});



app.put('/api/modules/:id/reset', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const rq = new sql.Request(tx);
    const r = await rq
      .input('id', sql.Int, id)
      .query(`
        UPDATE dbo.Modules
        SET icon = NULL,
            description = NULL
        WHERE moduleId = @id;

        SELECT moduleId, name, icon, description
        FROM dbo.Modules WHERE moduleId=@id;
      `);

    // r.recordsets[1] có SELECT cuối
    const row = r.recordsets?.[1]?.[0];
    if (!row) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    await tx.commit();
    return res.json({ success: true, data: row, message: '✅ Đã reset module.' });
  } catch (err) {
    console.error('❌ Reset module error:', err);
    try { await tx.rollback(); } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/////////////

app.get('/api/user-modules/:userId', async (req, res) => {
  const id = Number(req.params.userId);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid userId' });

  try {
    const pool = await poolPromise;
    const r = await pool.request()
      .input('userId', sql.Int, id)
      .query(`
        SELECT um.userModuleId, um.userId, um.moduleId, um.role,
               m.name, m.icon, m.description
        FROM dbo.UserModules um
        JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId = @userId
        ORDER BY m.name ASC
      `);

    return res.json({ success: true, data: r.recordset });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put('/api/user-modules/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const { assignments = [] } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, message: 'Invalid userId' });

  // validate payload: role chỉ admin/user
  for (const a of assignments) {
    if (!a.moduleId || !['admin', 'user'].includes(a.role)) {
      return res.status(400).json({ success: false, message: 'Invalid assignments payload' });
    }
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // Xoá tất cả quyền hiện tại của user
    await new sql.Request(tx)
      .input('userId', sql.Int, userId)
      .query(`DELETE FROM dbo.UserModules WHERE userId=@userId`);

    // Chèn lại theo payload
    for (const a of assignments) {
      await new sql.Request(tx)
        .input('userId', sql.Int, userId)
        .input('moduleId', sql.Int, a.moduleId)
        .input('role', sql.NVarChar, a.role)
        .query(`
          INSERT INTO dbo.UserModules(userId, moduleId, role)
          VALUES(@userId, @moduleId, @role)
        `);
    }

    await tx.commit();
    return res.json({ success: true, data: { userId, count: assignments.length } });
  } catch (e) {
    console.error('Update user-modules error:', e);
    try { await tx.rollback(); } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/users', async (req, res) => {
  const { q = '', page = 1, pageSize = 12 } = req.query;
  const _page = Math.max(1, parseInt(page,10)||1);
  const _size = Math.max(1, Math.min(100, parseInt(pageSize,10)||12));
  const offset = (_page - 1) * _size;

  try {
    const pool = await poolPromise;

    const rCount = await pool.request()
      .input('q', sql.NVarChar, `%${q}%`)
      .query(`
        SELECT COUNT(*) AS total
        FROM dbo.Users
        WHERE (@q='%%' OR userName LIKE @q OR fullName LIKE @q OR email LIKE @q)
      `);
    const total = rCount.recordset[0]?.total || 0;

    const r = await pool.request()
      .input('q', sql.NVarChar, `%${q}%`)
      .input('size', sql.Int, _size)
      .input('offset', sql.Int, offset)
      .query(`
        SELECT userId, userName, fullName, email, isActive
        FROM dbo.Users
        WHERE (@q='%%' OR userName LIKE @q OR fullName LIKE @q OR email LIKE @q)
        ORDER BY userId DESC
        OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
      `);

    return res.json({ success: true, data: r.recordset, pagination: { page: _page, pageSize: _size, total } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/users/:userId/modules-roles
app.get("/api/users/:userId/modules-roles", async (req, res) => {
  const { userId } = req.params;
  const { q = "", page = 1, pageSize = 100 } = req.query;

  const _userId = parseInt(userId, 10);
  if (!Number.isInteger(_userId) || _userId <= 0) {
    return res.status(400).json({ success: false, message: "userId không hợp lệ" });
  }

  const _page = Math.max(1, parseInt(page, 10) || 1);
  const _size = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 100));
  const offset = (_page - 1) * _size;

  // Nếu q rỗng → LIKE '%'
  const qLike = q ? `%${q}%` : `%`;

  try {
    const pool = await poolPromise;

    // Đếm đúng số module đã được gán cho user
    const rCount = await pool.request()
      .input("userId", sql.Int, _userId)
      .input("q", sql.NVarChar, qLike)
      .query(`
        SELECT COUNT(*) AS total
        FROM dbo.UserModules um
        INNER JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId = @userId
          AND (@q = '%' OR m.name LIKE @q OR m.description LIKE @q)
      `);

    const total = rCount.recordset[0]?.total || 0;

    // Lấy danh sách module đã được gán kèm role
    const rData = await pool.request()
      .input("userId", sql.Int, _userId)
      .input("q", sql.NVarChar, qLike)
      .input("size", sql.Int, _size)
      .input("offset", sql.Int, offset)
      .query(`
        SELECT
          m.moduleId,
          m.name,
          m.icon,
          m.description,
          um.role
        FROM dbo.UserModules um
        INNER JOIN dbo.Modules m ON m.moduleId = um.moduleId
        WHERE um.userId = @userId
          AND (@q = '%' OR m.name LIKE @q OR m.description LIKE @q)
        ORDER BY m.moduleId ASC
        OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
      `);

    const data = rData.recordset.map(row => {
      const allowedRoles =
        row.role === "admin" ? ["admin", "user"] :
        row.role === "user"  ? ["user"] : [];
      return {
        moduleId: row.moduleId,
        name: row.name,
        icon: row.icon,
        description: row.description,
        role: row.role,         // tiện cho FE biết đang là admin/user
        allowedRoles
      };
    });

    return res.json({
      success: true,
      data,
      pagination: { page: _page, pageSize: _size, total }
    });
  } catch (err) {
    console.error("❌ /api/users/:userId/modules-roles error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});



////////////////////////////////
app.post('/refresh', async (req, res) => {
  try {
    const rt = req.cookies?.refresh_token;
    console.log(rt);
    if (!rt) return res.status(401).json({ success: false, message: 'Missing refresh token' });

    let decoded;
    try {
      decoded = jwt.verify(rt, process.env.JWT_REFRESH_SECRET); // { userID, iat, exp }
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    const pool = await poolPromise;
    const r = await pool.request()
      .input('userID', sql.Int, decoded.userID)
      .input('token', sql.NVarChar, rt)
      .query(`SELECT TOP 1 * FROM dbo.RefreshTokens WHERE userID=@userID AND token=@token AND isRevoked=0 AND expiresAt>SYSDATETIME()`);

    const row = r.recordset[0];
    if (!row) return res.status(401).json({ success: false, message: 'Refresh token not found/expired' });

    // (Optional) rotate refresh token
    await pool.request()
      .input('id', sql.Int, row.id)
      .query(`UPDATE dbo.RefreshTokens SET isRevoked=1 WHERE id=@id`);

    const newRT = signRefreshToken({ userID: decoded.userID });
    const exp = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    await pool.request()
      .input('userID', sql.Int, decoded.userID)
      .input('token', sql.NVarChar, newRT)
      .input('expiresAt', sql.DateTime2, exp)
      .query(`INSERT INTO dbo.RefreshTokens(userID, token, expiresAt) VALUES (@userID, @token, @expiresAt)`);

    // Lấy lại thông tin user (role..)
    const ru = await pool.request()
      .input('userID', sql.Int, decoded.userID)
      .query(`SELECT TOP 1 userID, username, role, fullName FROM dbo.Users WHERE userID=@userID AND isActive=1`);

    const u = ru.recordset[0];
    if (!u) return res.status(401).json({ success: false, message: 'User disabled' });

    const accessToken = signAccessToken({ userID: u.userID, username: u.username, role: u.role, fullName: u.fullName });

    setRefreshCookie(res, newRT);
    return res.json({ success: true, data: { accessToken } });
  } catch (e) {
    console.error('refresh error', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    const rt = req.cookies?.refresh_token;
    if (rt) {
      const { poolPromise, sql } = require('./db');
      const pool = await poolPromise;
      await pool.request()
        .input('token', sql.NVarChar, rt)
        .query(`UPDATE dbo.RefreshTokens SET isRevoked=1 WHERE token=@token`);
    }
    res.clearCookie('refresh_token', { path: '/refresh' });
    return res.json({ success: true });
  } catch {
    return res.json({ success: true });
  }
});


/** ******************************************** */

// GET /api/trash-bins/:id/details
app.get('/api/trash-bins/:code/details', async (req, res) => {
  const trashBinCode = req.params.code;

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('trashBinCode', sql.NVarChar(100), trashBinCode)
      .query(`
        SELECT
          tb.trashBinID,
          tb.trashBinCode,
          d.departmentName,
          u.unitName,
          tt.trashName,
          tb.stringJsonCodeQr,
          tb.createdAt, tb.createdBy,
          tb.updatedAt, tb.updatedBy
        FROM dbo.TrashBins tb
        LEFT JOIN dbo.Departments d ON d.departmentID = tb.departmentID
        LEFT JOIN dbo.Units       u ON u.unitID       = tb.unitID
        LEFT JOIN dbo.TrashTypes  tt ON tt.trashTypeID= tb.trashTypeID
        WHERE tb.trashBinCode = @trashBinCode
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy trashBinCode' });
    }

    return res.json({ data: result.recordset[0] });
  } catch (err) {
    console.error('Lỗi lấy chi tiết thùng rác:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/trash-bins/details-by-selection
app.get('/api/trash-bins/details-by-selection', async (req, res) => {
  const trashTypeId  = req.query.trashTypeId ? Number(req.query.trashTypeId) : null;
  const departmentId = req.query.departmentId ? Number(req.query.departmentId) : null;
  const lineId       = req.query.lineId ? Number(req.query.lineId) : null;

  if (!trashTypeId) {
    return res.status(400).json({ error: 'trashTypeId là bắt buộc' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('trashTypeId',  sql.Int, trashTypeId)
      .input('departmentId', sql.Int, departmentId)
      .input('lineId',       sql.Int, lineId);

    // 1) Cố gắng map sang trashBinCode trong TrashBins nếu có đủ key
    //    - Nếu departmentId/lineId không truyền, vẫn cho phép match theo phần có sẵn (TOP 1).
    const mapSql = `
      SELECT TOP (1)
        tb.trashBinCode,
        d.departmentName,
        u.unitName,
        tt.trashName
      FROM dbo.TrashTypes  tt
      LEFT JOIN dbo.TrashBins tb 
             ON tb.trashTypeID = tt.trashTypeID
            AND (@departmentId IS NULL OR tb.departmentID = @departmentId)
            AND (@lineId       IS NULL OR tb.unitID       = @lineId)
      LEFT JOIN dbo.Departments d ON d.departmentID = (CASE WHEN @departmentId IS NOT NULL THEN @departmentId ELSE tb.departmentID END)
      LEFT JOIN dbo.Units       u ON u.unitID       = (CASE WHEN @lineId       IS NOT NULL THEN @lineId       ELSE tb.unitID END)
      WHERE tt.trashTypeID = @trashTypeId
      ORDER BY tb.trashBinID ASC
    `;
    const mapRs = await request.query(mapSql);
    const row = mapRs.recordset[0];

    if (row) {
      return res.json({
        data: {
          trashBinCode:  row.trashBinCode || null,
          departmentName: row.departmentName || null,
          unitName:       row.unitName || null,
          trashName:      row.trashName || null,
        },
      });
    }

    // 2) Nếu KHÔNG map được TrashBins, vẫn trả về tên từ bảng danh mục (để UI hiển thị)
    //    Tách query danh mục để có tên.
    const detailsRs = await pool.request()
      .input('trashTypeId',  sql.Int, trashTypeId)
      .input('departmentId', sql.Int, departmentId)
      .input('lineId',       sql.Int, lineId)
      .query(`
        SELECT
          (SELECT trashName     FROM dbo.TrashTypes  WHERE trashTypeID = @trashTypeId)  AS trashName,
          (SELECT departmentName FROM dbo.Departments WHERE departmentID = @departmentId) AS departmentName,
          (SELECT unitName       FROM dbo.Units       WHERE unitID       = @lineId)       AS unitName
      `);

    const d = detailsRs.recordset[0] || {};
    return res.json({
      data: {
        trashBinCode:  null, // không map được
        departmentName: d.departmentName || null,
        unitName:       d.unitName || null,
        trashName:      d.trashName || null,
      },
    });
  } catch (err) {
    console.error('Lỗi details-by-selection:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});


// GET /api/trash-bins/active  → lấy danh sách đã JOIN (chỉ isActive=1 theo VIEW)
app.get('/api/trash-bins/active', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 200);

    const q = (req.query.q || '').toString().trim(); // search trashBinCode
    const departmentId = req.query.departmentId ? parseInt(req.query.departmentId, 10) : null;
    const unitId       = req.query.unitId ? parseInt(req.query.unitId, 10) : null;
    const trashTypeId  = req.query.trashTypeId ? parseInt(req.query.trashTypeId, 10) : null;

    const offset = (page - 1) * pageSize;

    const pool = await poolPromise;

    // COUNT
    const countReq = pool.request()
      .input('q', sql.NVarChar(200), q ? `%${q}%` : null)
      .input('departmentId', sql.Int, Number.isInteger(departmentId) ? departmentId : null)
      .input('unitId',       sql.Int, Number.isInteger(unitId) ? unitId : null)
      .input('trashTypeId',  sql.Int, Number.isInteger(trashTypeId) ? trashTypeId : null);

    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.v_ActiveTrashBins t
      WHERE (@q IS NULL OR t.trashBinCode LIKE @q)
        AND (@departmentId IS NULL OR t.departmentID = @departmentId)
        AND (@unitId       IS NULL OR t.unitID       = @unitId)
        AND (@trashTypeId  IS NULL OR t.trashTypeID  = @trashTypeId);
    `;
    const total = (await countReq.query(countSql)).recordset?.[0]?.total || 0;

    // PAGE DATA
    const dataReq = pool.request()
      .input('q', sql.NVarChar(200), q ? `%${q}%` : null)
      .input('departmentId', sql.Int, Number.isInteger(departmentId) ? departmentId : null)
      .input('unitId',       sql.Int, Number.isInteger(unitId) ? unitId : null)
      .input('trashTypeId',  sql.Int, Number.isInteger(trashTypeId) ? trashTypeId : null)
      .input('offset', sql.Int, offset)
      .input('fetch',  sql.Int, pageSize);

    const dataSql = `
      SELECT
        trashBinID, trashBinCode, departmentID, unitID, trashTypeID,
        qrLink, isActive, stringJsonCodeQr,
        createdAt, createdBy, updatedAt, updatedBy,
        departmentName, unitName, trashName
      FROM dbo.v_ActiveTrashBins t
      WHERE (@q IS NULL OR t.trashBinCode LIKE @q)
        AND (@departmentId IS NULL OR t.departmentID = @departmentId)
        AND (@unitId       IS NULL OR t.unitID       = @unitId)
        AND (@trashTypeId  IS NULL OR t.trashTypeID  = @trashTypeId)
      ORDER BY t.trashBinID DESC
      OFFSET @offset ROWS FETCH NEXT @fetch ROWS ONLY;
    `;
    const pageData = (await dataReq.query(dataSql)).recordset || [];

    res.json({
      data: pageData,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    });
  } catch (err) {
    console.error('GET /trash-bins/active error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// PUT /api/trash-bins/:id  → chỉnh sửa (ví dụ: qrLink, trashBinCode)
app.put('/api/trash-bins/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    let { qrLink } = req.body || {};
    // sanitize chuỗi (tránh EPARAM Invalid string)
    const clean = (v, max = 500) => (typeof v === 'string'
      ? v.replace(/\u0000/g, '').trim().slice(0, max)
      : null);

    qrLink = clean(qrLink, 500);

    const pool = await poolPromise;
    const reqDb = pool.request()
      .input('id', sql.Int, id)
      .input('qrLink', sql.NVarChar(500), qrLink);

    const rs = await reqDb.query(`
      UPDATE dbo.TrashBins
      SET
        qrLink = COALESCE(@qrLink, qrLink),
        updatedAt = SYSDATETIME()
      WHERE trashBinID = @id;

      SELECT TOP 1
        tb.trashBinID, tb.trashBinCode, tb.departmentID, tb.unitID, tb.trashTypeID,
        tb.qrLink, tb.isActive, tb.stringJsonCodeQr,
        tb.createdAt, tb.createdBy, tb.updatedAt, tb.updatedBy,
        d.departmentName, u.unitName, tt.trashName
      FROM dbo.TrashBins tb
      LEFT JOIN dbo.Departments d ON d.departmentID = tb.departmentID
      LEFT JOIN dbo.Units       u ON u.unitID       = tb.unitID
      LEFT JOIN dbo.TrashTypes  tt ON tt.trashTypeID= tb.trashTypeID
      WHERE tb.trashBinID = @id;
    `);

    res.json({ data: rs.recordset?.[0] || null });
  } catch (err) {
    console.error('PUT /trash-bins/:id error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /api/trash-bins/:id  → xoá mềm (isActive = 0)
app.delete('/api/trash-bins/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const pool = await poolPromise;
    await pool.request()
      .input('id', sql.Int, id)
      .query(`
        UPDATE dbo.TrashBins
        SET isActive = 0, updatedAt = SYSDATETIME()
        WHERE trashBinID = @id;
      `);

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /trash-bins/:id error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /api/trash-bins/:id/restore  → khôi phục (isActive = 1)
app.patch('/api/trash-bins/:id/restore', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const pool = await poolPromise;
    await pool.request()
      .input('id', sql.Int, id)
      .query(`
        UPDATE dbo.TrashBins
        SET isActive = 1, updatedAt = SYSDATETIME()
        WHERE trashBinID = @id;
      `);

    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /trash-bins/:id/restore error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/trash-bins  (có status: active | deleted | all)
app.get('/api/trash-bins', async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 20,
      q,
      departmentId,
      unitId,
      trashTypeId,
      status = 'active', // active | deleted | all
    } = req.query;

    const p = Math.max(1, Number(page));
    const ps = Math.max(1, Math.min(500, Number(pageSize)));
    const offset = (p - 1) * ps;

    const where = [];
    const inputs = [];

    // Trạng thái
    if (status === 'deleted') where.push('tb.isActive = 0');
    else if (status === 'all') where.push('1=1');
    else where.push('tb.isActive = 1');

    if (q) {
      where.push('(tb.trashBinCode LIKE @kw)');
      inputs.push({ name: 'kw', type: sql.NVarChar, value: `%${q}%` });
    }
    if (departmentId) {
      where.push('tb.departmentID = @depId');
      inputs.push({ name: 'depId', type: sql.Int, value: Number(departmentId) });
    }
    if (unitId) {
      where.push('tb.unitID = @unitId');
      inputs.push({ name: 'unitId', type: sql.Int, value: Number(unitId) });
    }
    if (trashTypeId) {
      where.push('tb.trashTypeID = @ttId');
      inputs.push({ name: 'ttId', type: sql.Int, value: Number(trashTypeId) });
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const pool = await poolPromise;
    const reqM = pool.request();
    inputs.forEach(i => reqM.input(i.name, i.type, i.value));
    reqM.input('offset', sql.Int, offset);
    reqM.input('ps', sql.Int, ps);

    const sqlQuery = `
      DECLARE @Q TABLE (
        trashBinID   INT,
        trashBinCode NVARCHAR(100),
        qrLink       NVARCHAR(MAX),
        isActive     BIT,
        departmentName NVARCHAR(200),
        unitName       NVARCHAR(200),
        trashName      NVARCHAR(200)
      );

      INSERT INTO @Q (trashBinID, trashBinCode, qrLink, isActive, departmentName, unitName, trashName)
      SELECT
        tb.trashBinID,
        tb.trashBinCode,
        tb.qrLink,
        tb.isActive,
        d.departmentName,
        u.unitName,
        tt.trashName
      FROM dbo.TrashBins tb
      LEFT JOIN dbo.Departments d ON d.departmentID = tb.departmentID
      LEFT JOIN dbo.Units u       ON u.unitID       = tb.unitID
      LEFT JOIN dbo.TrashTypes tt ON tt.trashTypeID = tb.trashTypeID
      ${whereSql};

      -- Tổng
      SELECT COUNT(1) AS total FROM @Q;

      -- Trang dữ liệu
      SELECT *
      FROM @Q
      ORDER BY trashBinID DESC
      OFFSET @offset ROWS FETCH NEXT @ps ROWS ONLY;
    `;

    const rs = await reqM.query(sqlQuery);
    const total = rs.recordsets[0]?.[0]?.total ?? 0;
    const data  = rs.recordsets[1] ?? [];

    res.json({
      data,
      pagination: {
        page: p,
        pageSize: ps,
        total,
        totalPages: Math.max(1, Math.ceil(total / ps)),
      }
    });
  } catch (err) {
    console.error('GET /api/trash-bins error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



/////////////////////////////////////////////////////////////////////

// Departments (active hoặc NULL coi như active nếu cần)
app.get('/api/lookups/qr/departments', async (req, res) => {
  try {
    // mặc định 26/08/2025 -> dùng ISO tránh lỗi locale
    const minDateStr = (req.query.minDate || '2025-08-26').toString();

    // validate YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(minDateStr)) {
      return res.status(400).json({ error: 'minDate must be YYYY-MM-DD' });
    }

    const pool = await poolPromise;
    const rs = await pool.request()
      .input('minDate', sql.Date, minDateStr)
      .query(`
        SELECT departmentID, departmentName
        FROM dbo.Departments
        WHERE CONVERT(date, ISNULL(updatedAt, createdAt)) > @minDate
        ORDER BY departmentName;
      `);

    res.json(rs.recordset || []);
  } catch (e) {
    console.error('GET /lookups/departments', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Units (tuỳ chọn lọc theo departmentId)
app.get('/api/lookups/qr/units', async (req, res) => {
  try {
    const departmentId = req.query.departmentId ? parseInt(req.query.departmentId, 10) : null;
    const minDateStr = (req.query.minDate || '2025-08-26').toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(minDateStr)) {
      return res.status(400).json({ error: 'minDate must be YYYY-MM-DD' });
    }
    const pool = await poolPromise;
    const r = await pool.request()
      .input('departmentId', sql.Int, Number.isInteger(departmentId) ? departmentId : null)
      .input('minDate', sql.Date, minDateStr)
      .query(`
        SELECT unitID, unitName, departmentID
        FROM dbo.Units
        WHERE (@departmentId IS NULL OR departmentID = @departmentId)
          AND CONVERT(date, ISNULL(updatedAt, createdAt)) > @minDate
        ORDER BY unitName;
      `);
    res.json(r.recordset || []);
  } catch (e) {
    console.error('GET /lookups/units', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Trash types
app.get('/api/lookups/qr/trash-types', async (req, res) => {
  try {
    const pool = await poolPromise;
    const rs = await pool.request().query(`
      SELECT trashTypeID, trashName
      FROM dbo.TrashTypes
      ORDER BY trashName;
    `);
    res.json(rs.recordset || []);
  } catch (e) {
    console.error('GET /lookups/trash-types', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


//----------------------------

// GET /api/org/qr-map
app.get("/api/org/qr-map", async (req, res) => {
  try {
    const pool = await poolPromise;

    // 1) Department list (bỏ điều kiện ngày để không lọc mất tổ)
    const depRs = await pool.request().query(`
      SELECT d.departmentID, d.departmentName
      FROM dbo.Departments d
      WHERE d.createdAt >= '2025-08-26'
      ORDER BY d.departmentName;
    `);

    // 2) Units + số QR + 3 thumbnail gần nhất
    const unitRs = await pool.request().query(`
      SELECT
        u.unitID, u.unitName, u.departmentID,
        COUNT(tb.trashBinID) AS qrCount,
        (
          SELECT TOP (3) tb2.qrLink
          FROM dbo.TrashBins tb2
          WHERE tb2.unitID = u.unitID
            AND COALESCE(tb2.isActive,1) = 1
            AND tb2.qrLink IS NOT NULL
          ORDER BY tb2.updatedAt DESC, tb2.trashBinID DESC
          FOR JSON PATH
        ) AS qrThumbsJson
      FROM dbo.Units u
      LEFT JOIN dbo.TrashBins tb
        ON tb.unitID = u.unitID
        AND COALESCE(tb.isActive,1) = 1
      GROUP BY u.unitID, u.unitName, u.departmentID
      ORDER BY u.unitName;
    `);

    // 3) Orphan QR theo bộ phận (QR không gắn unit) — yêu cầu TrashBins có departmentID
    const orphanRs = await pool.request().query(`
      SELECT
        d.departmentID,
        COUNT(tb.trashBinID) AS qrCountDept,
        (
          SELECT TOP (3) tb2.qrLink
          FROM dbo.TrashBins tb2
          WHERE tb2.departmentID = d.departmentID
            AND tb2.unitID IS NULL
            AND COALESCE(tb2.isActive,1) = 1
            AND tb2.qrLink IS NOT NULL
          ORDER BY tb2.updatedAt DESC, tb2.trashBinID DESC
          FOR JSON PATH
        ) AS qrThumbsJsonDept
      FROM dbo.Departments d
      LEFT JOIN dbo.TrashBins tb
        ON tb.departmentID = d.departmentID
        AND tb.unitID IS NULL
        AND COALESCE(tb.isActive,1) = 1
      GROUP BY d.departmentID;
    `);

    /** Build: Department -> Units[] (thêm “QR cấp bộ phận” nếu không có unit mà vẫn có QR) */
    const deps = (depRs.recordset || []).map(d => ({ ...d, units: [] }));
    const byDep = new Map(deps.map(d => [d.departmentID, d]));

    // map orphan
    const orphanMap = new Map();
    for (const row of orphanRs.recordset || []) {
      let thumbs = [];
      if (row.qrThumbsJsonDept) {
        try { thumbs = JSON.parse(row.qrThumbsJsonDept).map(o => o.qrLink).filter(Boolean); } catch {}
      }
      orphanMap.set(row.departmentID, {
        count: Number(row.qrCountDept) || 0,
        thumbs
      });
    }

    // push units
    for (const row of unitRs.recordset || []) {
      let thumbs = [];
      if (row.qrThumbsJson) {
        try { thumbs = JSON.parse(row.qrThumbsJson).map(o => o.qrLink).filter(Boolean); } catch {}
      }
      const unit = {
        unitID: row.unitID,
        unitName: row.unitName,
        departmentID: row.departmentID,
        qrCount: Number(row.qrCount) || 0,
        qrThumbs: thumbs,
        type: "unit",          // đánh dấu rõ type
        draggable: true
      };
      const dep = byDep.get(row.departmentID);
      if (dep) dep.units.push(unit);
    }

    // nếu dep không có unit nhưng có orphan QR → thêm 1 “pseudo unit”
    for (const dep of deps) {
      if (!dep.units || dep.units.length === 0) {
        const orphan = orphanMap.get(dep.departmentID);
        if (orphan && orphan.count > 0) {
          dep.units = [
            {
              unitID: `dep-${dep.departmentID}-orphans`,
              unitName: "(QR cấp bộ phận)",
              departmentID: dep.departmentID,
              qrCount: orphan.count,
              qrThumbs: orphan.thumbs,
              type: "deptOrphan",
              draggable: false
            }
          ];
        }
      }
    }

    res.json({ data: deps });
  } catch (e) {
    console.error("GET /api/org/qr-map", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Gallery ảnh QR cấp bộ phận (không gắn unit)
app.get("/api/org/department/:depId/qrs", async (req, res) => {
  try {
    const depId = parseInt(req.params.depId, 10);
    if (!Number.isInteger(depId)) return res.status(400).json({ error: "depId invalid" });

    const pool = await poolPromise;
    const rs = await pool.request()
      .input("depId", sql.Int, depId)
      .query(`
        SELECT tb.trashBinID, tb.trashBinCode, tb.qrLink, tb.updatedAt
        FROM dbo.TrashBins tb
        WHERE tb.departmentID = @depId
          AND tb.unitID IS NULL
          AND COALESCE(tb.isActive,1) = 1
          AND tb.qrLink IS NOT NULL
        ORDER BY tb.updatedAt DESC, tb.trashBinID DESC;
      `);

    res.json({ data: rs.recordset || [] });
  } catch (e) {
    console.error("GET /api/org/department/:depId/qrs", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// routes/org.js  (bổ sung)
app.get("/api/org/unit/:unitId/qrs", async (req, res) => {
  const unitId = parseInt(req.params.unitId, 10);
  if (!Number.isInteger(unitId)) return res.status(400).json({ error: "unitId không hợp lệ" });

  try {
    const pool = await poolPromise;
    const rs = await pool.request()
      .input("unitId", sql.Int, unitId)
      .query(`
        SELECT tb.trashBinID, tb.trashBinCode, tb.qrLink
        FROM dbo.TrashBins tb
        WHERE tb.unitID = @unitId
          AND COALESCE(tb.isActive,1) = 1
          AND tb.qrLink IS NOT NULL
        ORDER BY tb.updatedAt DESC, tb.trashBinID DESC;
      `);

    res.json({ data: rs.recordset || [] });
  } catch (e) {
    console.error("GET /api/org/unit/:unitId/qrs", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// routes/org.js (tiếp)
app.patch("/api/org/move-unit", async (req, res) => {
  const { unitId, toDepartmentId, cascadeTrashBins = true, updatedBy = null } = req.body || {};
  if (!Number.isInteger(unitId) || !Number.isInteger(toDepartmentId)) {
    return res.status(400).json({ error: "unitId và toDepartmentId phải là số nguyên." });
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    const reqTx = new sql.Request(tx);

    // Kiểm tra tồn tại
    const chk = await reqTx
      .input("unitId", sql.Int, unitId)
      .input("toDep", sql.Int, toDepartmentId)
      .query(`
        SELECT TOP 1 unitID FROM dbo.Units WHERE unitID = @unitId;
        SELECT TOP 1 departmentID FROM dbo.Departments WHERE departmentID = @toDep;
      `);

    if (chk.recordsets[0].length === 0) throw new Error("Unit không tồn tại");
    if (chk.recordsets[1].length === 0) throw new Error("Department đích không tồn tại");

    // Cập nhật Units.departmentID
    await reqTx
      .input("unitId2", sql.Int, unitId)
      .input("toDep2", sql.Int, toDepartmentId)
      .input("updatedBy", sql.NVarChar(100), updatedBy)
      .query(`
        UPDATE dbo.Units
        SET departmentID = @toDep2,
            updatedAt = GETDATE(),
            updatedBy = @updatedBy
        WHERE unitID = @unitId2;
      `);

    if (cascadeTrashBins) {
      // Cập nhật TrashBins.departmentID cho tất cả QR thuộc unit
      await reqTx
        .input("unitId3", sql.Int, unitId)
        .input("toDep3", sql.Int, toDepartmentId)
        .input("updatedBy2", sql.NVarChar(100), updatedBy)
        .query(`
          UPDATE dbo.TrashBins
          SET departmentID = @toDep3,
              updatedAt = GETDATE(),
              updatedBy = @updatedBy2
          WHERE unitID = @unitId3;
        `);
    }

    await tx.commit();
    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/org/move-unit", e);
    try { await tx.rollback(); } catch {}
    res.status(500).json({ error: e.message || "Internal Server Error" });
  }
});

////////////////////////////////////////

app.get('/api/trash-bins/qrs-all', async (req, res) => {
  try {
    const pool = await poolPromise;
    const rs = await pool.request().query(`
      SELECT tb.trashBinID, tb.trashBinCode, tb.qrLink
      FROM dbo.TrashBins tb
      WHERE COALESCE(tb.isActive,1) = 1
        AND tb.qrLink IS NOT NULL
      ORDER BY tb.trashBinCode ASC, tb.trashBinID ASC;
    `);
    res.json({ data: rs.recordset || [] });
  } catch (e) {
    console.error('GET /api/trash-bins/qrs-all', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


//////////////////////////////////////////////////

// GET /api/table/buckets
app.get('/api/table/buckets', async (req, res) => {
  try {
    const pool = await poolPromise;

    const buckets = await pool.request().query(`
      SELECT b.bucketID, b.bucketName, b.departmentID, b.orderIndex, b.isActive,
             d.departmentName
      FROM dbo.ReportBuckets b
      LEFT JOIN dbo.Departments d ON d.departmentID = b.departmentID
      WHERE b.isActive = 1
      ORDER BY b.orderIndex, b.bucketName;
    `);

    const units = await pool.request().query(`
      SELECT u.unitID, u.unitName, ub.bucketID, ub.orderIndex
      FROM dbo.UnitBucket ub
      JOIN dbo.Units u ON u.unitID = ub.unitID
      ORDER BY ub.bucketID, ub.orderIndex, u.unitName;
    `);

    const byBucket = new Map(
      buckets.recordset.map(b => [b.bucketID, { ...b, units: [] }])
    );
    for (const u of units.recordset) {
      const b = byBucket.get(u.bucketID);
      if (b) b.units.push({ unitID: u.unitID, unitName: u.unitName, orderIndex: u.orderIndex });
    }

    res.json({ data: Array.from(byBucket.values()) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// PATCH /api/table/move-unit  { unitId, toBucketId }
app.patch('/api/table/move-unit', async (req, res) => {
  const { unitId, toBucketId } = req.body || {};
  if (!Number.isInteger(unitId) || !Number.isInteger(toBucketId)) {
    return res.status(400).json({ error: 'unitId/toBucketId không hợp lệ' });
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // 1) Lấy bucket đích
    const req1 = new sql.Request(tx);
    const rsBucket = await req1
      .input('toBucketId', sql.Int, toBucketId)
      .query(`
        SELECT bucketID, departmentID
        FROM dbo.ReportBuckets
        WHERE bucketID = @toBucketId AND isActive = 1;
      `);
    if (rsBucket.recordset.length === 0) throw new Error('Bucket không tồn tại hoặc không active');

    // 2) Lấy max orderIndex hiện tại của tổ đích
    const req2 = new sql.Request(tx);
    const rsMax = await req2
      .input('toBucketId', sql.Int, toBucketId)
      .query(`
        SELECT ISNULL(MAX(orderIndex), -1) AS maxIdx
        FROM dbo.UnitBucket
        WHERE bucketID = @toBucketId;
      `);
    const nextIdx = (rsMax.recordset[0]?.maxIdx ?? -1) + 1;

    // 3) Upsert UnitBucket, set orderIndex = nextIdx
    const req3 = new sql.Request(tx);
    await req3
      .input('unitId', sql.Int, unitId)
      .input('toBucketId', sql.Int, toBucketId)
      .input('nextIdx', sql.Int, nextIdx)
      .query(`
        MERGE dbo.UnitBucket AS t
        USING (SELECT @unitId AS unitID, @toBucketId AS bucketID, @nextIdx AS orderIndex) s
        ON (t.unitID = s.unitID)
        WHEN MATCHED THEN
          UPDATE SET t.bucketID = s.bucketID, t.orderIndex = s.orderIndex, updatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (unitID, bucketID, orderIndex) VALUES (s.unitID, s.bucketID, s.orderIndex);
      `);

    // 4) Nếu bucket có departmentID -> cập nhật Units + TrashBins
    const depId = rsBucket.recordset[0].departmentID;
    if (depId) {
      const req4 = new sql.Request(tx);
      await req4
        .input('depId', sql.Int, depId)
        .input('unitId', sql.Int, unitId)
        .query(`
          UPDATE dbo.Units
            SET departmentID = @depId, updatedAt = SYSUTCDATETIME()
          WHERE unitID = @unitId;

          UPDATE dbo.TrashBins
            SET departmentID = @depId, updatedAt = SYSUTCDATETIME()
          WHERE unitID = @unitId;
        `);
    }

    await tx.commit();
    res.json({ status: 'ok' });
  } catch (e) {
    await tx.rollback().catch(()=>{});
    console.error(e);
    res.status(500).json({ error: 'Không thể chuyển chuyền', detail: e.message });
  }
});



app.patch('/api/table/reorder-buckets', async (req, res) => {
  try {
    const { orderedBucketIds } = req.body || {};
    if (!Array.isArray(orderedBucketIds) || orderedBucketIds.length === 0) {
      return res.status(400).json({ error: 'orderedBucketIds phải là mảng số nguyên' });
    }

    // Chuẩn hoá: chỉ giữ int
    const ids = orderedBucketIds.map(Number).filter(Number.isInteger);
    if (ids.length === 0) return res.status(400).json({ error: 'Danh sách không hợp lệ' });

    const pool = await poolPromise;

    // Dùng OPENJSON để cập nhật hàng loạt theo thứ tự
    await pool.request()
      .input('ids', sql.NVarChar, JSON.stringify(ids))
      .query(`
        DECLARE @t TABLE(bucketID INT, orderIndex INT);
        INSERT INTO @t(bucketID, orderIndex)
        SELECT TRY_CAST([value] AS INT) AS bucketID,
               ROW_NUMBER() OVER (ORDER BY [key]) AS orderIndex
        FROM OPENJSON(@ids);

        UPDATE b
          SET b.orderIndex = t.orderIndex,
              b.updatedAt  = SYSUTCDATETIME()
        FROM dbo.ReportBuckets b
        JOIN @t t ON t.bucketID = b.bucketID;
      `);

    res.json({ status: 'ok' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Không thể lưu thứ tự bucket' });
  }
});

// PATCH /api/table/reorder-units  { bucketId, orderedUnitIds: [..] }
app.patch('/api/table/reorder-units', async (req, res) => {
  const { bucketId, orderedUnitIds } = req.body || {};
  if (!Number.isInteger(bucketId) || !Array.isArray(orderedUnitIds)) {
    return res.status(400).json({ error: 'bucketId/orderedUnitIds không hợp lệ' });
  }

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();

    // Optionally: kiểm tra tất cả unit đều đang (hoặc sẽ) thuộc bucketId
    // Ở đây ta cứ cập nhật trực tiếp unit đang thuộc bucketId, unit khác bucket bỏ qua

    for (let i = 0; i < orderedUnitIds.length; i++) {
      const unitId = orderedUnitIds[i];
      const reqX = new sql.Request(tx);
      await reqX
        .input('bucketId', sql.Int, bucketId)
        .input('unitId', sql.Int, unitId)
        .input('ord', sql.Int, i)
        .query(`
          UPDATE dbo.UnitBucket
            SET orderIndex = @ord, updatedAt = SYSUTCDATETIME()
          WHERE unitID = @unitId AND bucketID = @bucketId;
        `);
    }

    await tx.commit();
    res.json({ status: 'ok' });
  } catch (e) {
    await tx.rollback().catch(()=>{});
    console.error(e);
    res.status(500).json({ error: 'Không thể lưu thứ tự', detail: e.message });
  }
});


//////////////////////////////////////////////////

// GET /api/modules/:moduleId/features
app.get('/api/modules/:moduleId/features', async (req, res) => {
  const moduleId = Number(req.params.moduleId);
  if (!moduleId) return res.status(400).json({ success:false, message:'Invalid moduleId' });

  try {
    const pool = await poolPromise;
    const r = await pool.request()
      .input('moduleId', sql.Int, moduleId)
      .query(`
        SELECT featureId, moduleId, code, name, description, defaultForAdmin, defaultForUser
        FROM dbo.ModuleFeatures
        WHERE moduleId=@moduleId
        ORDER BY code
      `);
    res.json({ success:true, data:r.recordset });
  } catch (e) {
    console.error('List features error:', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// POST /api/modules/:moduleId/features
// body: { code, name, description?, defaultForAdmin?, defaultForUser? }
app.post('/api/modules/:moduleId/features', async (req, res) => {
  const moduleId = Number(req.params.moduleId);
  const { code, name, description=null, defaultForAdmin=false, defaultForUser=false } = req.body || {};
  if (!moduleId || !code || !name) return res.status(400).json({ success:false, message:'Missing fields' });

  try {
    const pool = await poolPromise;
    // chống trùng code trong cùng module
    const dup = await pool.request()
      .input('moduleId', sql.Int, moduleId)
      .input('code', sql.NVarChar, code.trim())
      .query(`SELECT 1 FROM dbo.ModuleFeatures WHERE moduleId=@moduleId AND code=@code`);
    if (dup.recordset.length) {
      return res.status(409).json({ success:false, message:'Feature code already exists in this module' });
    }

    const r = await pool.request()
      .input('moduleId', sql.Int, moduleId)
      .input('code', sql.NVarChar, code.trim())
      .input('name', sql.NVarChar, name.trim())
      .input('description', sql.NVarChar, description)
      .input('dfa', sql.Bit, !!defaultForAdmin)
      .input('dfu', sql.Bit, !!defaultForUser)
      .query(`
        INSERT INTO dbo.ModuleFeatures(moduleId, code, name, description, defaultForAdmin, defaultForUser)
        OUTPUT INSERTED.*
        VALUES (@moduleId, @code, @name, @description, @dfa, @dfu)
      `);

    res.status(201).json({ success:true, data:r.recordset[0] });
  } catch (e) {
    console.error('Create feature error:', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// PUT /api/modules/:moduleId/features/:featureId
// body: { code, name, description?, defaultForAdmin?, defaultForUser? }
app.put('/api/modules/:moduleId/features/:featureId', async (req, res) => {
  const moduleId = Number(req.params.moduleId);
  const featureId = Number(req.params.featureId);
  const { code, name, description=null, defaultForAdmin=false, defaultForUser=false } = req.body || {};
  if (!moduleId || !featureId || !code || !name) {
    return res.status(400).json({ success:false, message:'Missing fields' });
  }

  try {
    const pool = await poolPromise;

    // tồn tại?
    const ex = await pool.request()
      .input('moduleId', sql.Int, moduleId)
      .input('featureId', sql.Int, featureId)
      .query(`SELECT 1 FROM dbo.ModuleFeatures WHERE moduleId=@moduleId AND featureId=@featureId`);
    if (!ex.recordset.length) return res.status(404).json({ success:false, message:'Not found' });

    // trùng code (khác id)
    const dup = await pool.request()
      .input('moduleId', sql.Int, moduleId)
      .input('featureId', sql.Int, featureId)
      .input('code', sql.NVarChar, code.trim())
      .query(`
        SELECT 1 FROM dbo.ModuleFeatures
        WHERE moduleId=@moduleId AND code=@code AND featureId<>@featureId
      `);
    if (dup.recordset.length) return res.status(409).json({ success:false, message:'Feature code already exists' });

    const r = await pool.request()
      .input('moduleId', sql.Int, moduleId)
      .input('featureId', sql.Int, featureId)
      .input('code', sql.NVarChar, code.trim())
      .input('name', sql.NVarChar, name.trim())
      .input('description', sql.NVarChar, description)
      .input('dfa', sql.Bit, !!defaultForAdmin)
      .input('dfu', sql.Bit, !!defaultForUser)
      .query(`
        UPDATE dbo.ModuleFeatures
        SET code=@code, name=@name, description=@description,
            defaultForAdmin=@dfa, defaultForUser=@dfu
        OUTPUT INSERTED.*
        WHERE moduleId=@moduleId AND featureId=@featureId
      `);

    res.json({ success:true, data:r.recordset[0] });
  } catch (e) {
    console.error('Update feature error:', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// DELETE /api/modules/:moduleId/features/:featureId
app.delete('/api/modules/:moduleId/features/:featureId', async (req, res) => {
  const moduleId = Number(req.params.moduleId);
  const featureId = Number(req.params.featureId);
  if (!moduleId || !featureId) return res.status(400).json({ success:false, message:'Invalid params' });

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // xoá grants trước
    await new sql.Request(tx)
      .input('moduleId', sql.Int, moduleId)
      .input('featureId', sql.Int, featureId)
      .query(`DELETE FROM dbo.UserModuleFeatureGrants WHERE moduleId=@moduleId AND featureId=@featureId`);

    const r = await new sql.Request(tx)
      .input('moduleId', sql.Int, moduleId)
      .input('featureId', sql.Int, featureId)
      .query(`
        DELETE FROM dbo.ModuleFeatures
        OUTPUT DELETED.featureId
        WHERE moduleId=@moduleId AND featureId=@featureId
      `);

    if (!r.recordset.length) {
      await tx.rollback();
      return res.status(404).json({ success:false, message:'Not found' });
    }

    await tx.commit();
    res.json({ success:true, data:{ featureId } });
  } catch (e) {
    try { await tx.rollback(); } catch {}
    console.error('Delete feature error:', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

//------

// GET /api/user-modules/:userId/:moduleId/features
// trả về danh sách feature + default + overridden + effective
app.get('/api/user-modules/:userId/:moduleId/features', async (req, res) => {
  const userId = Number(req.params.userId);
  const moduleId = Number(req.params.moduleId);
  if (!userId || !moduleId) return res.status(400).json({ success:false, message:'Invalid params' });

  try {
    const pool = await poolPromise;

    // role của user với module
    const roleRs = await pool.request()
      .input('userId', sql.Int, userId)
      .input('moduleId', sql.Int, moduleId)
      .query(`SELECT role FROM dbo.UserModules WHERE userId=@userId AND moduleId=@moduleId`);
    const role = roleRs.recordset[0]?.role || null; // 'admin' | 'user' | null

    // danh mục features
    const fRs = await pool.request()
      .input('moduleId', sql.Int, moduleId)
      .query(`
        SELECT featureId, code, name, description, defaultForAdmin, defaultForUser
        FROM dbo.ModuleFeatures
        WHERE moduleId=@moduleId
        ORDER BY code
      `);

    // grants override
    const gRs = await pool.request()
      .input('userId', sql.Int, userId)
      .input('moduleId', sql.Int, moduleId)
      .query(`
        SELECT featureId, isAllowed
        FROM dbo.UserModuleFeatureGrants
        WHERE userId=@userId AND moduleId=@moduleId
      `);
    const grantMap = new Map(gRs.recordset.map(x => [x.featureId, x.isAllowed]));

    const data = fRs.recordset.map(f => {
      const def = role === 'admin' ? !!f.defaultForAdmin : !!f.defaultForUser;
      const overridden = grantMap.has(f.featureId) ? grantMap.get(f.featureId) : null; // null|bit
      const effective = overridden === null ? def : !!overridden;
      return {
        featureId: f.featureId,
        code: f.code,
        name: f.name,
        description: f.description,
        defaultAllowed: def,
        overridden,         // null | true | false
        effectiveAllowed: effective
      };
    });

    res.json({ success:true, data, role });
  } catch (e) {
    console.error('Get user feature grants error:', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// PUT /api/user-modules/:userId/:moduleId/features
// body: { grants: Array<{ featureId:number, isAllowed:boolean }> }
// Lưu override khác default, còn giống default thì không lưu (xoá nếu tồn tại).
app.put('/api/user-modules/:userId/:moduleId/features', async (req, res) => {
  const userId = Number(req.params.userId);
  const moduleId = Number(req.params.moduleId);
  const { grants = [] } = req.body || {};
  if (!userId || !moduleId) return res.status(400).json({ success:false, message:'Invalid params' });

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();

    // role
    const roleRs = await new sql.Request(tx)
      .input('userId', sql.Int, userId)
      .input('moduleId', sql.Int, moduleId)
      .query(`SELECT role FROM dbo.UserModules WHERE userId=@userId AND moduleId=@moduleId`);
    const role = roleRs.recordset[0]?.role || null;

    // tất cả features của module
    const fRs = await new sql.Request(tx)
      .input('moduleId', sql.Int, moduleId)
      .query(`
        SELECT featureId, defaultForAdmin, defaultForUser
        FROM dbo.ModuleFeatures
        WHERE moduleId=@moduleId
      `);
    const defaults = new Map(
      fRs.recordset.map(f => [
        f.featureId,
        role === 'admin' ? !!f.defaultForAdmin : !!f.defaultForUser
      ])
    );
    const featureSet = new Set(fRs.recordset.map(f => f.featureId));

    // Xoá toàn bộ override cũ
    await new sql.Request(tx)
      .input('userId', sql.Int, userId)
      .input('moduleId', sql.Int, moduleId)
      .query(`DELETE FROM dbo.UserModuleFeatureGrants WHERE userId=@userId AND moduleId=@moduleId`);

    // Ghi lại các override khác default
    for (const g of grants) {
      const fid = Number(g.featureId);
      if (!featureSet.has(fid)) continue;

      const want = !!g.isAllowed;
      const def  = defaults.get(fid);
      if (want !== def) {
        await new sql.Request(tx)
          .input('userId', sql.Int, userId)
          .input('moduleId', sql.Int, moduleId)
          .input('featureId', sql.Int, fid)
          .input('isAllowed', sql.Bit, want)
          .query(`
            INSERT INTO dbo.UserModuleFeatureGrants(userId, moduleId, featureId, isAllowed)
            VALUES (@userId, @moduleId, @featureId, @isAllowed)
          `);
      }
    }

    await tx.commit();
    res.json({ success:true });
  } catch (e) {
    try { await tx.rollback(); } catch {}
    console.error('Save user feature grants error:', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});


////////////////////////////////////////////////////
//////--------- LẤY DANH SÁCH VẬT TƯ ---------//////

// helpers
const toKey = (s = '') =>
  String(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

const expandUnits = (unit = 'kg') => {
  const u = unit.trim().toLowerCase();
  if (u === 'cuộn' || u === 'cuon') return ['cuộn', 'cuon'];
  return [u]; // ví dụ: ['kg'], ['lít'], ...
};

app.get('/api/materials', async (req, res) => {
  const active = req.query.active === '0' ? 0 : 1;
  const q = (req.query.q || '').trim();

  try {
    const pool = await poolPromise;
    let rs = await pool.request()
        .query(`
          SELECT materialId, materialName, ingredientName, unit
          FROM dbo.Materials
          WHERE isActive = 1
        `);

    const data = rs.recordset.map(row => ({
      materialId: row.materialId,
      key: toKey(row.materialName),            // ví dụ: 'vải_vụn' -> 'vai_vun'
      label: row.materialName,                 // tên vật tư để hiển thị cột
      ingredient: row.ingredientName || '',    // so khớp cột "Tên" trong Excel
      units: expandUnits(row.unit || 'kg'),    // mảng đơn vị hợp lệ
    }));

    res.json({ success: true, data });
  } catch (e) {
    console.error('GET /api/materials error:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


//////////////////////////////////////////////////

// -------------------------- DASHBOARD ---------------------

// Helpers thời gian
function startOfWeek(d) {
  const dt = new Date(d);
  const day = dt.getDay(); // 0..CN
  const diff = (day + 6) % 7; // về T2
  dt.setDate(dt.getDate() - diff);
  dt.setHours(0,0,0,0);
  return dt;
}
function addDays(d, n)  { const dt = new Date(d); dt.setDate(dt.getDate()+n); dt.setHours(0,0,0,0); return dt; }
function addWeeks(d, n) { return addDays(d, n*7); }
function addMonths(d,n) { const dt = new Date(d); dt.setDate(1); dt.setMonth(dt.getMonth()+n); dt.setHours(0,0,0,0); return dt; }
function ymd(d){ return d.toISOString().slice(0,10); }
function viDaysShortLabel(d){ return ['CN','T2','T3','T4','T5','T6','T7'][d.getDay()]; }
function monthLabel(d){ return `T${d.getMonth()+1}/${d.getFullYear()}`; }
function titleWeek(weekStart) {
  const m = weekStart.getMonth()+1; const y = weekStart.getFullYear();
  // tuần thứ mấy trong tháng (xấp xỉ)
  const w = Math.ceil((weekStart.getDate())/7);
  return `Tuần ${w} - T${m}/${y}`;
}

function movingAvg3(arr) {
  if (!arr.length) return [];
  const out = [];
  for (let i=0;i<arr.length;i++){
    const a = i>0 ? arr[i-1] : arr[i];
    const b = arr[i];
    const c = i<arr.length-1 ? arr[i+1] : arr[i];
    out.push(+((a+b+c)/3).toFixed(1));
  }
  return out;
}

app.get('/api/trash/time-series', async (req, res) => {
  try {
    const VN_TZ = 'Asia/Ho_Chi_Minh';
const ymdLocal = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ }).format(d); // 'YYYY-MM-DD'
const viDay = (d) => ['CN','T2','T3','T4','T5','T6','T7'][new Date(d).getDay()];

    const granularity = String(req.query.granularity || 'day'); // day|week|month
    const weekOffset  = parseInt(req.query.weekOffset ?? '0', 10);
    const monthOffset = parseInt(req.query.monthOffset ?? '0', 10);
    const yearOffset  = parseInt(req.query.yearOffset ?? '0', 10);
    const department  = req.query.department && req.query.department !== '__ALL__' ? String(req.query.department) : null;
    const trashType   = req.query.trashType  && req.query.trashType  !== '__ALL__' ? String(req.query.trashType)  : null;

    const pool = await poolPromise;

    if (granularity === 'day') {
      // 7 ngày của tuần đang xét
      const base = new Date(); base.setHours(0,0,0,0);
      const weekStart = addWeeks(startOfWeek(base), weekOffset);
      const weekEnd   = addDays(weekStart, 7); // [start, end)
      const title = titleWeek(weekStart);

      const q = `
        SELECT w.workDate, SUM(w.weightKg) AS total
        FROM TrashWeighings w
        JOIN TrashBins b ON b.trashBinCode = w.trashBinCode
        LEFT JOIN Departments d ON d.departmentID = b.departmentID
        LEFT JOIN TrashTypes tt ON tt.trashTypeID = b.trashTypeID
        WHERE w.workDate >= @from AND w.workDate < @to
          AND (@dep IS NULL OR d.departmentName = @dep)
          AND (@type IS NULL OR tt.trashName = @type)
        GROUP BY w.workDate
      `;
      
 const rs = await pool.request()
   .input('from', sql.VarChar, ymdLocal(weekStart))
   .input('to',   sql.VarChar, ymdLocal(weekEnd))
        .input('dep',  sql.NVarChar, department)
        .input('type', sql.NVarChar, trashType)
   .query(`
     SELECT CONVERT(varchar(10), w.workDate, 23) AS d, SUM(w.weightKg) AS total
     FROM TrashWeighings w
     JOIN TrashBins b ON b.trashBinCode = w.trashBinCode
     LEFT JOIN Departments dpt ON dpt.departmentID = b.departmentID
     LEFT JOIN TrashTypes tt ON tt.trashTypeID = b.trashTypeID
     WHERE w.workDate >= CAST(@from AS date) AND w.workDate < CAST(@to AS date)
       AND (@dep IS NULL OR dpt.departmentName = @dep)
       AND (@type IS NULL OR tt.trashName = @type)
     GROUP BY CONVERT(varchar(10), w.workDate, 23)
   `);

      // map theo ngày
      
 const map = new Map();
 rs.recordset.forEach(r => map.set(r.d, Number(r.total)));

      const rows = [];
      for (let i=0;i<7;i++){
        
   const d = addDays(weekStart, i);
   const key = ymdLocal(d);
   rows.push({ key, label: viDay(d), weight: +(map.get(key) || 0).toFixed(1) });
      }
      const trend = movingAvg3(rows.map(p => p.weight));
      rows.forEach((p, idx) => p.trend = trend[idx]);

      // ====== thêm tính trend thật ======
for (let i = 0; i < rows.length; i++) {
  const recent = rows.slice(Math.max(0, i - 2), i + 1);
  const avg = recent.reduce((sum, r) => sum + (r.weight || 0), 0) / recent.length;
  rows[i].trend = +avg.toFixed(1);
}

return res.json({ title, data: rows });

    }

    if (granularity === 'week') {
      // các tuần cắt trong 1 tháng
      const baseMonth = addMonths(new Date(new Date().getFullYear(), new Date().getMonth(), 1), monthOffset);
      const monthStart = new Date(baseMonth); // ngày 1
      const monthEnd   = addMonths(monthStart, 1); // [start, end)
      const title = `Tháng ${monthStart.getMonth()+1}/${monthStart.getFullYear()}`;

      // lấy daily trong vùng mở rộng (để đủ tuần)
      const from = addDays(startOfWeek(monthStart), 0);
      const to   = addDays(startOfWeek(monthEnd), 7);

      const q = `
        SELECT w.workDate, SUM(w.weightKg) AS total
        FROM TrashWeighings w
        JOIN TrashBins b ON b.trashBinCode = w.trashBinCode
        LEFT JOIN Departments d ON d.departmentID = b.departmentID
        LEFT JOIN TrashTypes tt ON tt.trashTypeID = b.trashTypeID
        WHERE w.workDate >= @from AND w.workDate < @to
          AND (@dep IS NULL OR d.departmentName = @dep)
          AND (@type IS NULL OR tt.trashName = @type)
        GROUP BY w.workDate
      `;
      
 const rs = await pool.request()
   .input('from', sql.VarChar, ymdLocal(from))
   .input('to',   sql.VarChar, ymdLocal(to))
        .input('dep',  sql.NVarChar, department)
        .input('type', sql.NVarChar, trashType)
   .query(`
     SELECT CONVERT(varchar(10), w.workDate, 23) AS d, SUM(w.weightKg) AS total
     FROM TrashWeighings w
     JOIN TrashBins b ON b.trashBinCode = w.trashBinCode
     LEFT JOIN Departments dpt ON dpt.departmentID = b.departmentID
     LEFT JOIN TrashTypes tt ON tt.trashTypeID = b.trashTypeID
     WHERE w.workDate >= CAST(@from AS date) AND w.workDate < CAST(@to AS date)
       AND (@dep IS NULL OR dpt.departmentName = @dep)
       AND (@type IS NULL OR tt.trashName = @type)
     GROUP BY CONVERT(varchar(10), w.workDate, 23)
   `);

      const dmap = new Map();
      rs.recordset.forEach(r => dmap.set(r.d, Number(r.total)));

      // bucket theo tuần giao nhau với tháng
      const rows = [];
      let ws = startOfWeek(monthStart);
      // đảm bảo tuần bắt đầu không sau thángEnd
      while (ws < monthEnd) {
        const we = addDays(ws, 6);
        const intersects = !(we < monthStart || ws >= monthEnd);
        if (!intersects) { ws = addWeeks(ws, 1); continue; }

        let sum = 0;
        for (let i=0;i<7;i++) {
          const d = ymd(addDays(ws,i));
          sum += dmap.get(ymd(d)) || 0;
        }
        rows.push({
          key: `${ymd(ws)}_${ymd(addDays(ws,6))}`,
          label: `W${rows.length+1}`,
          weight: +sum.toFixed(1),
        });
        ws = addWeeks(ws, 1);
      }

      const trend = movingAvg3(rows.map(r => r.weight));
      rows.forEach((r,i) => r.trend = trend[i]);

      // ====== thêm tính trend thật ======
for (let i = 0; i < rows.length; i++) {
  const recent = rows.slice(Math.max(0, i - 2), i + 1);
  const avg = recent.reduce((sum, r) => sum + (r.weight || 0), 0) / recent.length;
  rows[i].trend = +avg.toFixed(1);
}

return res.json({ title, data: rows });

    }

    // month
    const base = new Date(); base.setHours(0,0,0,0);
    const year = base.getFullYear() + yearOffset;
    const yearStart = new Date(year, 0, 1);
    const yearEnd   = new Date(year+1, 0, 1);
    const title = `Năm ${year}`;

    const q = `
      SELECT YEAR(w.workDate) AS y, MONTH(w.workDate) AS m, SUM(w.weightKg) AS total
      FROM TrashWeighings w
      JOIN TrashBins b ON b.trashBinCode = w.trashBinCode
      LEFT JOIN Departments d ON d.departmentID = b.departmentID
      LEFT JOIN TrashTypes tt ON tt.trashTypeID = b.trashTypeID
      WHERE w.workDate >= @from AND w.workDate < @to
        AND (@dep IS NULL OR d.departmentName = @dep)
        AND (@type IS NULL OR tt.trashName = @type)
      GROUP BY YEAR(w.workDate), MONTH(w.workDate)
    `;
    const rs = await pool.request()
 .input('from', sql.VarChar, ymdLocal(yearStart))
 .input('to',   sql.VarChar, ymdLocal(yearEnd))
      .input('dep',  sql.NVarChar, department)
      .input('type', sql.NVarChar, trashType)
      .query(q);

    const map = new Map();
    rs.recordset.forEach(r => map.set(r.m, Number(r.total)));

    const rows = [];
    for (let m=1;m<=12;m++){
      const d = new Date(year, m-1, 1);
      rows.push({
        key: `${year}-${m}`,
        label: `T${m}`,
        weight: +(map.get(m) || 0).toFixed(1),
      });
    }
    const trend = movingAvg3(rows.map(r => r.weight));
    rows.forEach((r,i) => r.trend = trend[i]);

    // ====== thêm tính trend thật ======
for (let i = 0; i < rows.length; i++) {
  const recent = rows.slice(Math.max(0, i - 2), i + 1);
  const avg = recent.reduce((sum, r) => sum + (r.weight || 0), 0) / recent.length;
  rows[i].trend = +avg.toFixed(1);
}

return res.json({ title, data: rows });

  } catch (err) {
    console.error('time-series error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/trash/time-series-compare', async (req, res) => {
  const VN_TZ = 'Asia/Ho_Chi_Minh';
const ymdLocal = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ }).format(d); // 'YYYY-MM-DD'
const viDaysShort = ['CN','T2','T3','T4','T5','T6','T7'];
const viDaysShortLabel = (d) => viDaysShort[new Date(d).getDay()];
  try {
    const granularity = String(req.query.granularity || 'day');
    const weekOffset  = parseInt(req.query.weekOffset ?? '0', 10);
    const monthOffset = parseInt(req.query.monthOffset ?? '0', 10);
    const yearOffset  = parseInt(req.query.yearOffset ?? '0', 10);
    const trashType   = req.query.trashType && req.query.trashType !== '__ALL__' ? String(req.query.trashType) : null;

    const departments = String(req.query.departments || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0,5);

    if (!departments.length) {
      return res.status(400).json({ message: 'Thiếu danh sách departments' });
    }

    const pool = await poolPromise;

    let title = '';

    // =========================
    // GRANULARITY: DAY (tuần)
    // =========================
    if (granularity === 'day') {
      const base = new Date(); base.setHours(0,0,0,0);
      const wsDate = addWeeks(startOfWeek(base), weekOffset);
      title = titleWeek(wsDate);

      // Khung 7 ngày
      const frame = [];
      for (let i=0;i<7;i++){
        const d = addDays(wsDate, i);
        frame.push({ key: ymdLocal(d), label: viDaysShortLabel(d) });
      }

      const fromStr = ymdLocal(wsDate);
      const toStr   = ymdLocal(addDays(wsDate, 7));

      const placeholders = departments.map((_, i) => `@dep${i}`).join(',');

      const reqq = pool.request()
        .input('from', sql.VarChar, fromStr)
        .input('to',   sql.VarChar, toStr)
        .input('type', sql.NVarChar, trashType);

      departments.forEach((dep, i) => reqq.input(`dep${i}`, sql.NVarChar, dep));

      const rs = await reqq.query(`
        SELECT dpt.departmentName AS dep,
               CONVERT(varchar(10), w.workDate, 23) AS d,  -- 'YYYY-MM-DD'
               SUM(w.weightKg) AS total
        FROM TrashWeighings w
        JOIN TrashBins b  ON b.trashBinCode = w.trashBinCode
        LEFT JOIN Departments dpt ON dpt.departmentID = b.departmentID
        LEFT JOIN TrashTypes tt   ON tt.trashTypeID   = b.trashTypeID
        WHERE w.workDate >= CAST(@from AS date) AND w.workDate < CAST(@to AS date)
          AND dpt.departmentName IN (${placeholders})
          AND (@type IS NULL OR tt.trashName = @type)
        GROUP BY dpt.departmentName, CONVERT(varchar(10), w.workDate, 23)
      `);

      const map = new Map(); // key: d|dep
      rs.recordset.forEach(r => map.set(`${r.d}|${r.dep}`, Number(r.total)));

      const rows = frame.map(row => {
        const out = { ...row };
        departments.forEach(dep => { out[dep] = +(map.get(`${row.key}|${dep}`) || 0).toFixed(1); });
        return out;
      });

      return res.json({ title, data: rows });
    }

    // =========================
    // GRANULARITY: WEEK (các tuần trong tháng)
    // =========================
    if (granularity === 'week') {
      const monthStart = addMonths(new Date(new Date().getFullYear(), new Date().getMonth(), 1), monthOffset);
      const monthEnd   = addMonths(monthStart, 1);
      title = `Tháng ${monthStart.getMonth()+1}/${monthStart.getFullYear()}`;

      // Lấy daily rộng để đủ các tuần giao nhau
      const from = addDays(startOfWeek(monthStart), 0);
      const to   = addDays(startOfWeek(monthEnd),   7);

      const fromStr = ymdLocal(from);
      const toStr   = ymdLocal(to);

      const placeholders = departments.map((_, i) => `@dep${i}`).join(',');

      const reqq = pool.request()
        .input('from', sql.VarChar, fromStr)
        .input('to',   sql.VarChar, toStr)
        .input('type', sql.NVarChar, trashType);

      departments.forEach((dep, i) => reqq.input(`dep${i}`, sql.NVarChar, dep));

      const rs = await reqq.query(`
        SELECT dpt.departmentName AS dep,
               CONVERT(varchar(10), w.workDate, 23) AS d,  -- 'YYYY-MM-DD'
               SUM(w.weightKg) AS total
        FROM TrashWeighings w
        JOIN TrashBins b  ON b.trashBinCode = w.trashBinCode
        LEFT JOIN Departments dpt ON dpt.departmentID = b.departmentID
        LEFT JOIN TrashTypes tt   ON tt.trashTypeID   = b.trashTypeID
        WHERE w.workDate >= CAST(@from AS date) AND w.workDate < CAST(@to AS date)
          AND dpt.departmentName IN (${placeholders})
          AND (@type IS NULL OR tt.trashName = @type)
        GROUP BY dpt.departmentName, CONVERT(varchar(10), w.workDate, 23)
      `);

      const depDayMap = new Map(); // dep|d -> total
      rs.recordset.forEach(r => depDayMap.set(`${r.dep}|${r.d}`, Number(r.total)));

      // Bucket theo tuần giao với tháng
      let ws = startOfWeek(monthStart);
      const rows = [];
      while (ws < monthEnd) {
        const we = addDays(ws, 6);
        const intersects = !(we < monthStart || ws >= monthEnd);
        if (!intersects) { ws = addWeeks(ws, 1); continue; }

        const row = { key: `${ymdLocal(ws)}_${ymdLocal(we)}`, label: `W${rows.length+1}` };
        departments.forEach(dep => {
          let sum = 0;
          for (let i=0;i<7;i++){
            const d = ymdLocal(addDays(ws,i));
            sum += depDayMap.get(`${dep}|${d}`) || 0;
          }
          row[dep] = +sum.toFixed(1);
        });

        rows.push(row);
        ws = addWeeks(ws, 1);
      }

      return res.json({ title, data: rows });
    }

    // =========================
    // GRANULARITY: MONTH (12 tháng)
    // =========================
    const base = new Date(); base.setHours(0,0,0,0);
    const year = base.getFullYear() + yearOffset;
    const yearStart = new Date(year, 0, 1);
    const yearEnd   = new Date(year+1, 0, 1);
    title = `Năm ${year}`;

    const placeholders = departments.map((_, i) => `@dep${i}`).join(',');

    const reqq = pool.request()
      .input('from', sql.VarChar, ymdLocal(yearStart))
      .input('to',   sql.VarChar, ymdLocal(yearEnd))
      .input('type', sql.NVarChar, trashType);

    departments.forEach((dep, i) => reqq.input(`dep${i}`, sql.NVarChar, dep));

    const rs = await reqq.query(`
      SELECT dpt.departmentName AS dep,
             MONTH(w.workDate)  AS m,
             SUM(w.weightKg)    AS total
      FROM TrashWeighings w
      JOIN TrashBins b  ON b.trashBinCode = w.trashBinCode
      LEFT JOIN Departments dpt ON dpt.departmentID = b.departmentID
      LEFT JOIN TrashTypes tt   ON tt.trashTypeID   = b.trashTypeID
      WHERE w.workDate >= CAST(@from AS date) AND w.workDate < CAST(@to AS date)
        AND dpt.departmentName IN (${placeholders})
        AND (@type IS NULL OR tt.trashName = @type)
      GROUP BY dpt.departmentName, MONTH(w.workDate)
    `);

    const map = new Map(); // dep|m -> total
    rs.recordset.forEach(r => map.set(`${r.dep}|${r.m}`, Number(r.total)));

    const rows = [];
    for (let m=1; m<=12; m++){
      const row = { key: `${year}-${m}`, label: `T${m}` };
      departments.forEach(dep => { row[dep] = +(map.get(`${dep}|${m}`) || 0).toFixed(1); });
      rows.push(row);
    }

    return res.json({ title, data: rows });
  } catch (err) {
    console.error('time-series-compare error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/trash/drill', async (req, res) => {
  try {
    const granularity = String(req.query.granularity || 'day');
    const periodKey   = String(req.query.periodKey || '');
    const department  = String(req.query.department || '');
    const trashType   = req.query.trashType && req.query.trashType !== '__ALL__' ? String(req.query.trashType) : null;

    if (!periodKey || !department) return res.status(400).json({ message: 'Thiếu periodKey hoặc department' });

    let from, to;
    if (granularity === 'day') {
      from = new Date(periodKey);
      if (isNaN(+from)) return res.status(400).json({ message: 'periodKey day không hợp lệ' });
      from.setHours(0,0,0,0);
      to = addDays(from, 1);
    } else if (granularity === 'week') {
      const [s,e] = periodKey.split('_');
      from = new Date(s); to = addDays(new Date(e), 1);
      if (isNaN(+from) || isNaN(+to)) return res.status(400).json({ message: 'periodKey week không hợp lệ' });
    } else {
      // month: "YYYY-M"
      const [y,m] = periodKey.split('-').map(n => parseInt(n,10));
      if (!y || !m) return res.status(400).json({ message: 'periodKey month không hợp lệ' });
      from = new Date(y, m-1, 1);
      to   = new Date(y, m, 1);
    }

    const pool = await poolPromise;
    const q = `
      SELECT b.trashBinCode, u.unitName, SUM(w.weightKg) AS total
      FROM TrashWeighings w
      JOIN TrashBins b ON b.trashBinCode = w.trashBinCode
      LEFT JOIN Units u ON u.unitID = b.unitID
      LEFT JOIN Departments d ON d.departmentID = b.departmentID
      LEFT JOIN TrashTypes tt ON tt.trashTypeID = b.trashTypeID
      WHERE w.workDate >= @from AND w.workDate < @to
        AND d.departmentName = @dep
        AND (@type IS NULL OR tt.trashName = @type)
      GROUP BY b.trashBinCode, u.unitName
      ORDER BY SUM(w.weightKg) DESC
    `;
    const rs = await pool.request()
      .input('from', sql.Date, from)
      .input('to',   sql.Date, to)
      .input('dep',  sql.NVarChar, department)
      .input('type', sql.NVarChar, trashType)
      .query(q);

    const rows = rs.recordset.map(r => ({
      name: r.trashBinCode,
      unitName: r.unitName || '',
      weight: +Number(r.total).toFixed(1),
    }));
    return res.json({ rows });
  } catch (err) {
    console.error('drill error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.send('OK'));


/////////////////////////////////////////////


app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
});
