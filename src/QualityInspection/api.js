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

    const employeeName = req.user.fullName;
    const employeeId = req.user.username;

    const payload = {
      ...req.body,
      employeeId,
      employeeName,
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

    return res.json(response.data);
  } catch (err) {
    console.error('❌ Call internal API error:', {
      message: err.message,
      code: err.code,
      response: err.response?.data,
      url: err.config?.url
    });

    return res.status(500).json({
      success: false,
      message: 'Cannot save inspection result'
    });
  }
});

module.exports = router;
