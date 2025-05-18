require('dotenv').config();
const express = require("express");
const { sql, poolPromise } = require("./db");
const bcrypt = require("bcrypt");

const cors = require("cors");
const jwt = require("jsonwebtoken");
const SECRET = "Tai31072002@";

const app = express();
const port = process.env.PORT || 3000;


app.use(cors({
  origin: [
    'http://localhost:3000',
    'exp://127.0.0.1:19000',
    'https://duanrac-reactnative.azurewebsites.net'
  ],
  credentials: true
}));

app.use(express.json());

app.get("/users/get", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query("SELECT * FROM [Users]");
    res.json(result.recordset);
  } catch (err) {
    console.error("❌ Lỗi khi truy vấn:", err);
    res.status(500).send("Lỗi server");
  }
});

app.post("/trash-weighings", async (req, res) => {
  const { trashBinCode, userID, weighingTime, weightKg, updatedAt, updatedBy } = req.body;
  try {
    const pool = await poolPromise;
    await pool.request()
      .input("trashBinCode", sql.NVarChar, trashBinCode)
      .input("userID", sql.Int, userID)
      .input("weighingTime", sql.DateTime, weighingTime)
      .input("weightKg", sql.Float, weightKg)
      .input("updatedAt", sql.DateTime, updatedAt)
      .input("updatedBy", sql.Int, updatedBy)
      .query(`
        INSERT INTO TrashWeighings (trashBinCode, userID, weighingTime, weightKg, updatedAt, updatedBy)
        VALUES (@trashBinCode, @userID, @weighingTime, @weightKg, @updatedAt, @updatedBy)
      `);
    res.send("✅ Đã thêm bản ghi cân rác");
  } catch (err) {
    res.status(500).send("❌ Lỗi khi thêm dữ liệu");
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



app.listen(port, () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
});
