require('dotenv').config();
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { poolPromise, sql } = require('../db');

const INTERNAL_API = process.env.API_WEBAPP_NOI_BO;

router.post('/save-result', requireAuth, async (req, res) => {
  try {
    if (!INTERNAL_API) {
      return res.status(500).json({
        success: false,
        message: 'Internal API not configured'
      });
    }

    const {
      inspectionType,
      qrCode,
      inspectionDateTime,
      result
    } = req.body;

    const userID = req.user.userID;
    const employeeName = req.user.username;

    // ✅ LẤY msnv TỪ DATABASE
    const pool = await poolPromise;

    const userResult = await pool.request()
      .input('userID', sql.Int, userID)
      .query(`
        SELECT msnv
        FROM dbo.Users
        WHERE userID = @userID
          AND isDeleted = 0
          AND isActive = 1
      `);

    if (!userResult.recordset.length) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy nhân viên'
      });
    }

    const employeeId = userResult.recordset[0].msnv;

    // ✅ Payload gửi internal API
    const payload = {
      inspectionType,
      employeeId,     // 🔥 giờ là msnv
      employeeName,
      qrCode,
      inspectionDateTime,
      result
    };

    const response = await axios.post(
      `${INTERNAL_API}/api/server/backup/quality-inspection/save-result`,
      payload,
      {
        timeout: 60000,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Request': 'WEBAPP'
        }
      }
    );

    res.json(response.data);

  } catch (err) {
    console.error('❌ Call internal API error:', {
      message: err.message,
      code: err.code,
      response: err.response?.data,
      url: err.config?.url
    });

    res.status(500).json({
      success: false,
      message: 'Cannot save inspection result'
    });
  }
});

module.exports = router;
