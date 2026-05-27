require('dotenv').config();
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { poolPromise, sql } = require('../db');

const INTERNAL_API = process.env.API_WEBAPP_NOI_BO;


// Tạo axios instance dùng chung
const internalApi = axios.create({
  baseURL: INTERNAL_API,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Request': 'WEBAPP'
  }
});

// Hàm build query params, bỏ giá trị rỗng
function buildQueryParams(queryObj) {
  const params = {};

  Object.keys(queryObj).forEach((key) => {
    const value = queryObj[key];
    if (value !== undefined && value !== null && value !== '') {
      params[key] = value;
    }
  });

  return params;
}

// Hàm kiểm tra cấu hình internal api
function validateInternalApi(res) {
  if (!INTERNAL_API) {
    res.status(500).json({
      success: false,
      message: 'Internal API not configured'
    });
    return false;
  }
  return true;
}

// Hàm log lỗi đẹp hơn
function logProxyError(title, err) {
  console.error(`❌ ${title}:`, {
    message: err.message,
    code: err.code,
    response: err.response?.data,
    status: err.response?.status,
    url: err.config?.url,
    method: err.config?.method
  });
}


/**
 * GG SHEET - GET INFO BY CODE
 * GET /api/server/backup/ggSheet/get-info-by-code
 * query:
 * - codes: code1,code2,code3
 */
router.get('/get-info-by-code', async (req, res) => {
  try {
    if (!validateInternalApi(res)) return;

    const { codes } = req.query;

    if (!codes) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu parameter codes',
      });
    }

    const params = buildQueryParams({
      codes,
    });

    const response = await internalApi.get(
      '/api/server/backup/ggSheet/get-info-by-code',
      {
        params,
        headers: {
          'X-User-Id': req.user?.userID || '',
          'X-Username': req.user?.username || '',
        },
      }
    );

    return res.json(response.data);

  } catch (err) {
    logProxyError('Proxy get info by code error', err);

    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Không thể lấy dữ liệu theo CODE_PHAN',
    });
  }
});



module.exports = router;
