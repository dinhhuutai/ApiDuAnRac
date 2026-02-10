require('dotenv').config();
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');

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

    const employeeId = req.user.userID;
    const employeeName = req.user.username;

    const payload = {
      inspectionType,
      employeeId,
      employeeName,
      qrCode,
      inspectionDateTime,
      result
    };
    
    console.log(payload);

    const response = await axios.post(
      `${INTERNAL_API}/api/server/backup/quality-inspection/save-result`,
      payload,
      {
        timeout: 5000,
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
