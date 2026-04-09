require('dotenv').config();
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { poolPromise, sql } = require('../db');

const INTERNAL_API = process.env.API_WEBAPP_NOI_BO;

// router.post('/save-result', requireAuth, async (req, res) => {
//   try {
//     if (!INTERNAL_API) {
//       return res.status(500).json({
//         success: false,
//         message: 'Internal API not configured'
//       });
//     }

//     const employeeName = req.user.fullName;
//     const employeeId = req.user.username;

//     const payload = {
//       ...req.body,
//       employeeId,
//       employeeName,
//     };

//     const response = await axios.post(
//       `${INTERNAL_API}/api/server/backup/quality-inspection/save-result`,
//       payload,
//       {
//         timeout: 60000,
//         headers: {
//           'Content-Type': 'application/json',
//           'X-Internal-Request': 'WEBAPP'
//         }
//       }
//     );

//     return res.json(response.data);
//   } catch (err) {
//     console.error('❌ Call internal API error:', {
//       message: err.message,
//       code: err.code,
//       response: err.response?.data,
//       url: err.config?.url
//     });

//     return res.status(500).json({
//       success: false,
//       message: 'Cannot save inspection result'
//     });
//   }
// });

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

    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;

    // Business error: pass-through nguyên trạng về FE
    if (err.response) {
      if (status === 409) {
        console.warn('⚠️ Duplicate scan 24h:', {
          status,
          response: data,
          url: err.config?.url
        });
      } else {
        console.error('❌ Call internal API error:', {
          message: err.message,
          code: err.code,
          status,
          response: data,
          url: err.config?.url
        });
      }

      return res.status(status).json(
        data || {
          success: false,
          message: 'Internal API error'
        }
      );
    }

    // Network / timeout / cannot connect internal API
    console.error('❌ Call internal API network error:', {
      message: err.message,
      code: err.code,
      url: err.config?.url
    });

    return res.status(500).json({
      success: false,
      message: 'Cannot save inspection result'
    });
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    if (!INTERNAL_API) {
      return res.status(500).json({
        success: false,
        message: 'Internal API not configured'
      });
    }

    const employeeId = req.user.username;

    const response = await axios.get(
      `${INTERNAL_API}/api/server/backup/quality-inspection/history`,
      {
        timeout: 60000,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Request': 'WEBAPP'
        },
        params: {
          inspectionType: req.query.inspectionType,
          employeeId,
          date: req.query.date || '',
          qrCode: req.query.qrCode || '',
          page: req.query.page || 1,
          pageSize: req.query.pageSize || 20
        }
      }
    );

    return res.json(response.data);
  } catch (err) {
    console.error('❌ Call internal API history error:', {
      message: err.message,
      code: err.code,
      response: err.response?.data,
      url: err.config?.url
    });

    return res.status(err.response?.status || 500).json(
      err.response?.data || {
        success: false,
        message: 'Cannot get inspection history'
      }
    );
  }
});

router.get('/admin-history-summary', requireAuth, async (req, res) => {
  try {
    if (!INTERNAL_API) {
      return res.status(500).json({
        success: false,
        message: 'Internal API not configured'
      });
    }

    const response = await axios.get(
      `${INTERNAL_API}/api/server/backup/quality-inspection/admin-history-summary`,
      {
        timeout: 180000,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Request': 'WEBAPP'
        },
        params: {
          fromDate: req.query.fromDate || '',
          toDate: req.query.toDate || '',
          errorOnly: req.query.errorOnly || 'false',
          inspectionType: req.query.inspectionType || 'KCS'
        }
      }
    );

    return res.json(response.data);
  } catch (err) {
    console.error('❌ admin-history-summary proxy error:', {
      message: err.message,
      code: err.code,
      response: err.response?.data,
      url: err.config?.url
    });

    return res.status(err.response?.status || 500).json(
      err.response?.data || {
        success: false,
        message: 'Cannot get admin history summary'
      }
    );
  }
});

router.post('/admin-history-rerun', requireAuth, async (req, res) => {
  try {
    const response = await axios.post(
      `${INTERNAL_API}/api/server/backup/quality-inspection/admin-history-rerun`,
      req.body,
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
    return res.status(err.response?.status || 500).json(
      err.response?.data || {
        success: false,
        message: 'Cannot rerun ERP'
      }
    );
  }
});

router.post('/admin-history-rerun-bulk', requireAuth, async (req, res) => {
  try {
    const response = await axios.post(
      `${INTERNAL_API}/api/server/backup/quality-inspection/admin-history-rerun-bulk`,
      req.body,
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
    return res.status(err.response?.status || 500).json(
      err.response?.data || {
        success: false,
        message: 'Cannot rerun ERP bulk'
      }
    );
  }
});

module.exports = router;
