// auth.util.js
const jwt = require('jsonwebtoken');

const signAccessToken = (payload) =>
  jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: process.env.JWT_ACCESS_EXPIRES || '60m' });

const signRefreshToken = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES || '30d' });

const setRefreshCookie = (res, rt) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('refresh_token', rt, {
    httpOnly: true,
    secure: isProd,           // true khi HTTPS/production
    sameSite: isProd ? 'strict' : 'lax',
    path: '/auth/refresh',    // chỉ gửi cho route này
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 ngày
  });
};

module.exports = { signAccessToken, signRefreshToken, setRefreshCookie };
