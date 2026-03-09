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
 * 1) ORDERS
 * GET /api/server/backup/mes/orders
 * query:
 * - fromDate
 * - toDate
 * - orderId
 * - customerName
 * - mstatus
 */
router.get('/orders', requireAuth, async (req, res) => {
  try {
    if (!validateInternalApi(res)) return;

    const {
      fromDate,
      toDate,
      orderId,
      customerName,
      mstatus
    } = req.query;

    const params = buildQueryParams({
      fromDate,
      toDate,
      orderId,
      customerName,
      mstatus
    });

    const response = await internalApi.get('/api/server/backup/mes/orders', {
      params,
      headers: {
        'X-User-Id': req.user?.userID || '',
        'X-Username': req.user?.username || ''
      }
    });

    return res.json(response.data);
  } catch (err) {
    logProxyError('Proxy get orders error', err);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Không thể lấy danh sách đơn hàng'
    });
  }
});

/**
 * 2) ITEMS theo OrderID
 * GET /api/mes/orders/:orderId/items
 * query:
 * - fromDate
 * - toDate
 * - itemCode
 * - mstatus
 */
router.get('/orders/:orderId/items', requireAuth, async (req, res) => {
  try {
    if (!validateInternalApi(res)) return;

    const { orderId } = req.params;
    const {
      fromDate,
      toDate,
      itemCode,
      mstatus
    } = req.query;

    const params = buildQueryParams({
      fromDate,
      toDate,
      itemCode,
      mstatus
    });

    const response = await internalApi.get(`/api/server/backup/mes/orders/${orderId}/items`, {
      params,
      headers: {
        'X-User-Id': req.user?.userID || '',
        'X-Username': req.user?.username || ''
      }
    });

    return res.json(response.data);
  } catch (err) {
    logProxyError('Proxy get items error', err);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Không thể lấy danh sách mã hàng'
    });
  }
});

/**
 * 3) DETAILS theo ItemID
 * GET /api/mes/items/:itemId/details
 * query:
 * - fromDate
 * - toDate
 * - detailCode
 * - mstatus
 */
router.get('/items/:itemId/details', requireAuth, async (req, res) => {
  try {
    if (!validateInternalApi(res)) return;

    const { itemId } = req.params;
    const {
      fromDate,
      toDate,
      detailCode,
      mstatus
    } = req.query;

    const params = buildQueryParams({
      fromDate,
      toDate,
      detailCode,
      mstatus
    });

    const response = await internalApi.get(`/api/server/backup/mes/items/${itemId}/details`, {
      params,
      headers: {
        'X-User-Id': req.user?.userID || '',
        'X-Username': req.user?.username || ''
      }
    });

    return res.json(response.data);
  } catch (err) {
    logProxyError('Proxy get details error', err);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Không thể lấy danh sách chi tiết'
    });
  }
});

/**
 * 4) BATCHES theo DetailID
 * GET /api/mes/details/:detailId/batches
 * query:
 * - fromDate
 * - toDate
 * - qualityStatus
 */
router.get('/details/:detailId/batches', requireAuth, async (req, res) => {
  try {
    if (!validateInternalApi(res)) return;

    const { detailId } = req.params;
    const {
      fromDate,
      toDate,
      qualityStatus
    } = req.query;

    const params = buildQueryParams({
      fromDate,
      toDate,
      qualityStatus
    });

    const response = await internalApi.get(`/api/server/backup/mes/details/${detailId}/batches`, {
      params,
      headers: {
        'X-User-Id': req.user?.userID || '',
        'X-Username': req.user?.username || ''
      }
    });

    return res.json(response.data);
  } catch (err) {
    logProxyError('Proxy get batches error', err);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Không thể lấy danh sách batch'
    });
  }
});

module.exports = router;