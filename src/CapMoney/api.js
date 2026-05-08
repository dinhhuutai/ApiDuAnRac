require('dotenv').config();
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { poolPromise, sql } = require('../db');



module.exports = router;

// ================== CapMoney APIs ==================
// NOTE: Mình gắn endpoint trực tiếp lên cùng object `router` đã export,
// nên vẫn đảm bảo export đúng dù file khai báo module.exports ở đầu.

const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 5,
  },
});

// ================= Helpers (bám theo pattern module task) =================
function getExtLower(filename = '') {
  return path.extname(filename || '').toLowerCase();
}

function sanitizeFileName(name = 'file') {
  const s = String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return s.length > 180 ? s.slice(0, 180) : s;
}

function toUtf8FileName(name) {
  try {
    return Buffer.from(String(name), 'latin1').toString('utf8');
  } catch {
    return String(name);
  }
}

function makeSafeStoredName(originalName) {
  const clean = toUtf8FileName(originalName);
  const ext = getExtLower(clean) || '';
  const base = clean.replace(new RegExp(`${ext}$`, 'i'), '');
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${stamp}_${rand}_${base}${ext}`.replace(/\s+/g, '_');
}

const BLOCKED_MIMES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-bat',
  'application/x-powershell',
  'application/x-dosexec',
]);

const BLOCKED_EXTS = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.msi',
  '.com',
  '.scr',
]);

function parseAccountId(accountIdRaw) {
  const s = String(accountIdRaw ?? 'all').trim().toLowerCase();
  if (!s || s === 'all') return { type: 'all', accountId: null, accountType: null };
  if (s === 'wallet') return { type: 'type', accountId: null, accountType: 'Wallet' };
  if (s === 'bank') return { type: 'type', accountId: null, accountType: 'Bank' };
  const n = Number(accountIdRaw);
  if (Number.isFinite(n) && n > 0) return { type: 'id', accountId: n, accountType: null };
  return { type: 'all', accountId: null, accountType: null };
}

function transactionTypeToId(typeCodeRaw) {
  const s = String(typeCodeRaw ?? '').trim().toUpperCase();
  if (s === 'EXPENSE') return 1;
  if (s === 'INCOME') return 2;
  if (s === 'TRANSFER') return 3;
  const n = Number(typeCodeRaw);
  return Number.isFinite(n) ? n : null;
}

// ================== GET: /home-summary ==================
router.get('/home-summary', requireAuth, async (req, res) => {
  try {
    const uid = req.user.userID;
    const { mode = 'month', month, date, accountId } = req.query || {};

    const _mode = String(mode).trim().toLowerCase();
    if (!['day', 'month'].includes(_mode)) {
      return res.status(400).json({ success: false, message: 'mode phải là day|month' });
    }

    // Parse target selection
    const now = new Date();
    const todayDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;

    let selectedDateStr = todayDateStr;
    let selectedMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    if (_mode === 'month') {
      if (!month || !/^\d{4}-\d{2}$/.test(String(month))) {
        return res.status(400).json({ success: false, message: 'month phải là YYYY-MM' });
      }
      selectedMonthStr = String(month);
      const y = Number(selectedMonthStr.slice(0, 4));
      const m = Number(selectedMonthStr.slice(5, 7));
      selectedDateStr = `${y}-${String(m).padStart(2, '0')}-01`;
    } else {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return res.status(400).json({ success: false, message: 'date phải là YYYY-MM-DD' });
      }
      selectedDateStr = String(date);
      selectedMonthStr = selectedDateStr.slice(0, 7);
    }

    const [calYear, calMonth] = selectedMonthStr.split('-').map(Number);
    const calendarStartStr = `${selectedMonthStr}-01`;
    const calendarEndDate = new Date(calYear, calMonth, 0);
    const calendarEndStr = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(
      calendarEndDate.getDate()
    ).padStart(2, '0')}`;

    const accFilter = parseAccountId(accountId);
    const pool = await poolPromise;

    // user info
    const rUser = await pool
      .request()
      .input('uid', sql.Int, uid)
      .query(`
        SELECT TOP 1 fullName, avatar
        FROM dbo.Users
        WHERE userID = @uid
      `);
    const fullName = rUser.recordset?.[0]?.fullName || 'Người dùng';
    const avatar = rUser.recordset?.[0]?.avatar || null;
    const greetingName = (fullName || '').split(/\s+/)[0] || fullName;

    // accounts
    const rAccounts = await pool
      .request()
      .input('uid', sql.Int, uid)
      .query(`
        SELECT
          accountId,
          accountName,
          accountType,
          isDefault
        FROM dbo.cm_Accounts
        WHERE userId = @uid
          AND ISNULL(isDelete, 0) = 0
        ORDER BY displayOrder, accountId
      `);

    // summary + calendarDays
    const rSummary = await pool
      .request()
      .input('uid', sql.Int, uid)
      .input('mode', sql.NVarChar(10), _mode)
      .input('selectedDate', sql.Date, selectedDateStr)
      .input('selectedMonth', sql.NVarChar(7), selectedMonthStr) // YYYY-MM
      .input('todayDate', sql.Date, todayDateStr)
      .input('accId', sql.Int, accFilter.type === 'id' ? accFilter.accountId : null)
      .input('accType', sql.NVarChar(20), accFilter.type === 'type' ? accFilter.accountType : null)
      .query(`
        DECLARE @calendarStart DATE = CONVERT(DATE, CONCAT(@selectedMonth, '-01'));
        DECLARE @calendarEnd   DATE = EOMONTH(@calendarStart);

        DECLARE @periodStart DATE;
        DECLARE @periodEnd   DATE;

        IF (@mode = 'month')
        BEGIN
          SET @periodStart = @calendarStart;
          SET @periodEnd = @calendarEnd;
        END
        ELSE
        BEGIN
          SET @periodStart = @selectedDate;
          SET @periodEnd = @selectedDate;
        END

        ;WITH dates AS (
          SELECT @calendarStart AS d
          UNION ALL
          SELECT DATEADD(DAY, 1, d)
          FROM dates
          WHERE d < @calendarEnd
        ),
        trx AS (
          SELECT
            CAST(t.transactionDate AS DATE) AS d,
            t.transactionTypeId,
            t.amount
          FROM dbo.cm_Transactions t
          INNER JOIN dbo.cm_Accounts a
            ON a.accountId = t.accountId
           AND a.userId = @uid
           AND ISNULL(a.isDelete, 0) = 0
          WHERE ISNULL(t.isDelete, 0) = 0
            AND CAST(t.transactionDate AS DATE) BETWEEN @calendarStart AND @calendarEnd
            AND (
              @accId IS NULL
              AND (@accType IS NULL OR a.accountType = @accType)
              OR
              @accId IS NOT NULL
              AND t.accountId = @accId
            )
        ),
        daily AS (
          SELECT
            d,
            SUM(CASE WHEN transactionTypeId = 1 THEN amount ELSE 0 END) AS totalExpense,
            SUM(CASE WHEN transactionTypeId = 2 THEN amount ELSE 0 END) AS totalIncome,
            COUNT(1) AS transactionCount
          FROM trx
          GROUP BY d
        )
        SELECT
          CONVERT(VARCHAR(10), dates.d, 23) AS date,
          COALESCE(daily.totalExpense, 0) AS totalExpense,
          COALESCE(daily.totalIncome, 0) AS totalIncome,
          COALESCE(daily.transactionCount, 0) AS transactionCount,
          CASE WHEN COALESCE(daily.transactionCount, 0) > 0 THEN 1 ELSE 0 END AS hasTransaction,

          periodTotalExpense = (
            SELECT COALESCE(SUM(CASE WHEN trx2.transactionTypeId = 1 THEN trx2.amount ELSE 0 END), 0)
            FROM trx trx2
            WHERE trx2.d BETWEEN @periodStart AND @periodEnd
          ),
          periodTotalIncome = (
            SELECT COALESCE(SUM(CASE WHEN trx3.transactionTypeId = 2 THEN trx3.amount ELSE 0 END), 0)
            FROM trx trx3
            WHERE trx3.d BETWEEN @periodStart AND @periodEnd
          ),
          todayTotalExpense = (
            SELECT COALESCE(SUM(CASE WHEN trx4.transactionTypeId = 1 THEN trx4.amount ELSE 0 END), 0)
            FROM trx trx4
            WHERE trx4.d = @todayDate
          ),
          todayTotalIncome = (
            SELECT COALESCE(SUM(CASE WHEN trx5.transactionTypeId = 2 THEN trx5.amount ELSE 0 END), 0)
            FROM trx trx5
            WHERE trx5.d = @todayDate
          )
        FROM dates
        LEFT JOIN daily ON daily.d = dates.d
        ORDER BY dates.d;
      `);

    // rSummary ở đây là 1 recordset (calendarDays + totals lặp theo mỗi day)
    const calendarDays = rSummary.recordset || [];
    const totalsSeed = calendarDays[0] || {};
    const totalExpense = Number(totalsSeed.periodTotalExpense || 0);
    const totalIncome = Number(totalsSeed.periodTotalIncome || 0);
    const totalExpenseToday = Number(totalsSeed.todayTotalExpense || 0);
    const totalIncomeToday = Number(totalsSeed.todayTotalIncome || 0);

    // day preview images (up to 2 images/day)
    const rDayImages = await pool
      .request()
      .input('uid', sql.Int, uid)
      .input('calendarStart', sql.Date, calendarStartStr)
      .input('calendarEnd', sql.Date, calendarEndStr)
      .input('accId', sql.Int, accFilter.type === 'id' ? accFilter.accountId : null)
      .input('accType', sql.NVarChar(20), accFilter.type === 'type' ? accFilter.accountType : null)
      .query(`
        ;WITH tx_images AS (
          SELECT
            CONVERT(VARCHAR(10), CAST(t.transactionDate AS DATE), 23) AS [date],
            ti.imageUrl,
            ROW_NUMBER() OVER (
              PARTITION BY CAST(t.transactionDate AS DATE)
              ORDER BY t.transactionDate DESC, t.transactionId DESC, ti.displayOrder ASC, ti.transactionImageId ASC
            ) AS rn
          FROM dbo.cm_Transactions t
          INNER JOIN dbo.cm_Accounts a
            ON a.accountId = t.accountId
           AND a.userId = @uid
           AND ISNULL(a.isDelete, 0) = 0
          INNER JOIN dbo.cm_TransactionImages ti
            ON ti.transactionId = t.transactionId
           AND ISNULL(ti.isDelete, 0) = 0
          WHERE ISNULL(t.isDelete, 0) = 0
            AND CAST(t.transactionDate AS DATE) BETWEEN @calendarStart AND @calendarEnd
            AND (
              @accId IS NULL AND (@accType IS NULL OR a.accountType = @accType)
              OR
              @accId IS NOT NULL AND t.accountId = @accId
            )
        )
        SELECT [date], imageUrl, rn
        FROM tx_images
        WHERE rn <= 2
        ORDER BY [date], rn;
      `);

    const dayImagesMap = new Map();
    for (const row of rDayImages.recordset || []) {
      if (!row?.date || !row?.imageUrl) continue;
      if (!dayImagesMap.has(row.date)) dayImagesMap.set(row.date, []);
      dayImagesMap.get(row.date).push(row.imageUrl);
    }

    res.json({
      success: true,
      data: {
        greetingName,
        fullName,
        avatar,
        selectedMonth: selectedMonthStr,
        selectedDate: selectedDateStr,
        mode: _mode,
        summaryToday: {
          totalExpenseToday,
          totalIncomeToday,
          hasAnyToday: totalExpenseToday + totalIncomeToday > 0,
        },
        summaryPeriod: { totalExpense, totalIncome },
        accounts: (rAccounts.recordset || []).map((a) => ({
          accountId: a.accountId,
          accountName: a.accountName,
          accountType: a.accountType,
          isDefault: Boolean(a.isDefault),
        })),
        selectedAccountId: accFilter.type === 'id' ? accFilter.accountId : null,
        selectedAccountType: accFilter.type === 'type' ? accFilter.accountType : 'all',
        calendarDays: calendarDays.map((d) => ({
          date: d.date,
          totalExpense: Number(d.totalExpense || 0),
          totalIncome: Number(d.totalIncome || 0),
          transactionCount: Number(d.transactionCount || 0),
          hasTransaction: Boolean(d.hasTransaction),
          previewImages: dayImagesMap.get(d.date) || [],
        })),
      },
    });
  } catch (err) {
    console.error('capmoney home-summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== GET: /categories ==================
router.get('/categories', requireAuth, async (req, res) => {
  try {
    const uid = req.user.userID;
    const { transactionType } = req.query || {};
    const typeId = transactionTypeToId(transactionType);

    if (![1, 2].includes(Number(typeId))) {
      return res.status(400).json({
        success: false,
        message: 'transactionType phải là EXPENSE hoặc INCOME',
      });
    }

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('uid', sql.Int, uid)
      .input('typeId', sql.Int, Number(typeId))
      .query(`
        SELECT
          categoryId,
          categoryName,
          categoryIcon,
          categoryColor,
          displayOrder,
          transactionTypeId
        FROM dbo.cm_Categories
        WHERE userId = @uid
          AND ISNULL(isDelete, 0) = 0
          AND transactionTypeId = @typeId
        ORDER BY displayOrder, categoryId
      `);

    res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error('capmoney categories error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== GET: /accounts ==================
router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const uid = req.user.userID;
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('uid', sql.Int, uid)
      .query(`
        SELECT
          accountId,
          accountName,
          accountType,
          isDefault
        FROM dbo.cm_Accounts
        WHERE userId = @uid
          AND ISNULL(isDelete, 0) = 0
        ORDER BY displayOrder, accountId
      `);
    res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error('capmoney accounts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== POST: /transactions ==================
router.post('/transactions', requireAuth, upload.any(), async (req, res) => {
  let tx;
  try {
    const uid = req.user.userID;

    const {
      transactionTypeCode,
      transactionTypeId,
      accountId,
      categoryId,
      amount,
      transactionDate,
      detailNote,
      locationText,
    } = req.body || {};

    const typeResolved = transactionTypeToId(transactionTypeId ?? transactionTypeCode);

    const accId = Number(accountId);
    const catId = Number(categoryId);
    const amountNum = Number(amount);

    if (![1, 2].includes(Number(typeResolved))) {
      return res.status(400).json({ success: false, message: 'transactionType phải là EXPENSE hoặc INCOME' });
    }
    if (!Number.isFinite(accId) || accId <= 0) {
      return res.status(400).json({ success: false, message: 'accountId không hợp lệ' });
    }
    if (!Number.isFinite(catId) || catId <= 0) {
      return res.status(400).json({ success: false, message: 'categoryId không hợp lệ' });
    }
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: 'amount phải > 0' });
    }
    if (!transactionDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(transactionDate))) {
      return res.status(400).json({ success: false, message: 'transactionDate phải là YYYY-MM-DD' });
    }

    const pool = await poolPromise;
    tx = new sql.Transaction(pool);
    await tx.begin();

    // validate account
    const rAcc = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('accountId', sql.Int, accId)
      .query(`
        SELECT accountId
        FROM dbo.cm_Accounts
        WHERE accountId = @accountId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0
      `);

    if (!rAcc.recordset.length) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Account không hợp lệ' });
    }

    // validate category + type
    const rCat = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('categoryId', sql.Int, catId)
      .query(`
        SELECT categoryId, transactionTypeId
        FROM dbo.cm_Categories
        WHERE categoryId = @categoryId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0
      `);

    if (!rCat.recordset.length) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Category không hợp lệ' });
    }
    const catTypeId = Number(rCat.recordset[0].transactionTypeId);
    if (catTypeId !== Number(typeResolved)) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Category không đúng loại giao dịch' });
    }

    // 1) insert transaction
    const detail = detailNote ?? null;
    const location = locationText ?? null;

    const rInsTx = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionTypeId', sql.Int, Number(typeResolved))
      .input('accountId', sql.Int, accId)
      .input('categoryId', sql.Int, catId)
      .input('amount', sql.Decimal(18, 2), amountNum)
      .input('transactionDate', sql.Date, transactionDate)
      .input('detailNote', sql.NVarChar(sql.MAX), detail)
      .input('locationText', sql.NVarChar(sql.MAX), location)
      .input('createdBy', sql.Int, uid)
      .query(`
        DECLARE @New TABLE (transactionId INT);
        INSERT INTO dbo.cm_Transactions
          (userID, transactionTypeId, accountId, categoryId, amount, transactionDate,
           detailNote, locationText, createdBy, createdDate, isDelete)
        OUTPUT INSERTED.transactionId INTO @New(transactionId)
        VALUES
          (@uid, @transactionTypeId, @accountId, @categoryId, @amount, @transactionDate,
           @detailNote, @locationText, @createdBy, GETDATE(), 0);
        SELECT TOP 1 transactionId FROM @New;
      `);

    const transactionId = rInsTx.recordset?.[0]?.transactionId;
    if (!transactionId) {
      await tx.rollback();
      return res.status(500).json({ success: false, message: 'Không tạo được transaction' });
    }

    // 2) update balance
    const delta = Number(typeResolved) === 1 ? -amountNum : amountNum;
    await new sql.Request(tx)
      .input('accountId', sql.Int, accId)
      .input('uid', sql.Int, uid)
      .input('delta', sql.Decimal(18, 2), delta)
      .query(`
        UPDATE dbo.cm_Accounts
        SET currentBalance = ISNULL(currentBalance, 0) + @delta,
            updatedDate = SYSDATETIME(),
            updatedBy = @uid
        WHERE accountId = @accountId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0;
      `);

    // 3) save images
    const files = req.files || [];
    const uploadRoot = process.env.UPLOAD_ROOT || 'D:/uploads';
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://api.thuanhunglongan.com';

    let savedCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = getExtLower(file.originalname);
      const mime = (file.mimetype || '').toLowerCase();
      if (BLOCKED_MIMES.has(mime) || BLOCKED_EXTS.has(ext)) continue;
      if (!mime.startsWith('image/')) continue;

      const relDir = `/uploads/images/capmoney/${transactionId}`;
      const absDir = path.join(uploadRoot, 'images', 'capmoney', String(transactionId));
      await fs.ensureDir(absDir);

      const storedName = makeSafeStoredName(file.originalname);
      const absPath = path.join(absDir, storedName);
      await fs.writeFile(absPath, file.buffer);

      const storagePath = `${relDir}/${storedName}`;
      const imageUrl = `${String(publicBaseUrl).replace(/\/$/, '')}${storagePath}`;

      await new sql.Request(tx)
        .input('transactionId', sql.Int, transactionId)
        .input('imageUrl', sql.NVarChar(500), imageUrl)
        .input('imageName', sql.NVarChar(255), sanitizeFileName(file.originalname))
        .input('imageType', sql.NVarChar(100), file.mimetype)
        .input('fileSize', sql.BigInt, file.size)
        .input('displayOrder', sql.Int, i + 1)
        .input('createdBy', sql.Int, uid)
        .query(`
          INSERT INTO dbo.cm_TransactionImages
            (transactionId, imageUrl, imageName, imageType, fileSize,
             displayOrder, createdBy, createdDate, isDelete)
          VALUES
            (@transactionId, @imageUrl, @imageName, @imageType, @fileSize,
             @displayOrder, @createdBy, GETDATE(), 0);
        `);

      savedCount++;
    }

    await tx.commit();
    return res.status(201).json({
      success: true,
      message: 'Tạo giao dịch thành công',
      data: { transactionId, attachmentCount: savedCount },
    });
  } catch (err) {
    console.error('capmoney transactions create error:', err);
    try {
      if (tx) await tx.rollback();
    } catch {}
    return res.status(500).json({ success: false, message: 'Lỗi tạo giao dịch' });
  }
});

// ================== GET: /transactions/by-date/:date ==================
router.get('/transactions/by-date/:date', requireAuth, async (req, res) => {
  try {
    const uid = req.user.userID;
    const date = req.params.date;
    const { accountId } = req.query || {};

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ success: false, message: 'date phải là YYYY-MM-DD' });
    }

    const accFilter = parseAccountId(accountId);
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('uid', sql.Int, uid)
      .input('date', sql.Date, date)
      .input('accId', sql.Int, accFilter.type === 'id' ? accFilter.accountId : null)
      .input('accType', sql.NVarChar(20), accFilter.type === 'type' ? accFilter.accountType : null)
      .query(`
        ;WITH tx AS (
          SELECT
            t.transactionId,
            t.transactionTypeId,
            tt.transactionTypeCode AS transactionTypeCode,
            t.accountId,
            a.accountName,
            t.categoryId,
            c.categoryName,
            t.amount,
            t.transactionDate,
            t.detailNote,
            t.locationText
          FROM dbo.cm_Transactions t
          INNER JOIN dbo.cm_Accounts a
            ON a.accountId = t.accountId
           AND a.userId = @uid
           AND ISNULL(a.isDelete, 0) = 0
          LEFT JOIN dbo.cm_Categories c
            ON c.categoryId = t.categoryId
           AND ISNULL(c.isDelete, 0) = 0
          LEFT JOIN dbo.cm_TransactionTypes tt
            ON tt.transactionTypeId = t.transactionTypeId
           AND ISNULL(tt.isActive, 1) = 1
          WHERE ISNULL(t.isDelete, 0) = 0
            AND t.userId = @uid
            AND CAST(t.transactionDate AS DATE) = @date
            AND (
              @accId IS NULL AND (@accType IS NULL OR a.accountType = @accType)
              OR
              @accId IS NOT NULL AND t.accountId = @accId
            )
        )
        SELECT
          tx.*,
          img.imageUrl,
          totals.totalExpense,
          totals.totalIncome
        FROM tx
        OUTER APPLY (
          SELECT TOP 1 ti.imageUrl
          FROM dbo.cm_TransactionImages ti
          WHERE ti.transactionId = tx.transactionId
            AND ISNULL(ti.isDelete, 0) = 0
          ORDER BY ti.displayOrder ASC, ti.transactionImageId ASC
        ) img
        CROSS APPLY (
          SELECT
            totalExpense = COALESCE(SUM(CASE WHEN tx2.transactionTypeId = 1 THEN tx2.amount ELSE 0 END), 0),
            totalIncome  = COALESCE(SUM(CASE WHEN tx2.transactionTypeId = 2 THEN tx2.amount ELSE 0 END), 0)
          FROM tx tx2
        ) totals
        ORDER BY tx.transactionDate DESC, tx.transactionId DESC;
      `);

    const rows = r.recordset || [];
    const seed = rows[0] || {};
    res.json({
      success: true,
      data: {
        date,
        totalExpense: Number(seed.totalExpense || 0),
        totalIncome: Number(seed.totalIncome || 0),
        transactions: rows.map((x) => ({
          transactionId: x.transactionId,
          transactionTypeId: Number(x.transactionTypeId),
          transactionTypeCode: x.transactionTypeCode,
          accountId: x.accountId,
          accountName: x.accountName,
          categoryId: x.categoryId,
          categoryName: x.categoryName,
          amount: Number(x.amount || 0),
          transactionDate: x.transactionDate,
          detailNote: x.detailNote,
          locationText: x.locationText,
          imageUrl: x.imageUrl || null,
        })),
      },
    });
  } catch (err) {
    console.error('capmoney transactions/by-date error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== GET: /transactions/by-month/:month ==================
// month: YYYY-MM
router.get('/transactions/by-month/:month', requireAuth, async (req, res) => {
  try {
    const uid = req.user.userID;
    const month = req.params.month;
    const { accountId } = req.query || {};

    if (!month || !/^\d{4}-\d{2}$/.test(String(month))) {
      return res.status(400).json({ success: false, message: 'month phải là YYYY-MM' });
    }

    const [y, m] = String(month).split('-').map(Number);
    const startDate = `${String(month)}-01`;
    const endDateObj = new Date(y, m, 0);
    const endDate = `${y}-${String(m).padStart(2, '0')}-${String(endDateObj.getDate()).padStart(2, '0')}`;

    const accFilter = parseAccountId(accountId);
    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('uid', sql.Int, uid)
      .input('startDate', sql.Date, startDate)
      .input('endDate', sql.Date, endDate)
      .input('accId', sql.Int, accFilter.type === 'id' ? accFilter.accountId : null)
      .input('accType', sql.NVarChar(20), accFilter.type === 'type' ? accFilter.accountType : null)
      .query(`
        SELECT
          t.transactionId,
          t.transactionTypeId,
          t.amount,
          t.transactionDate,
          t.detailNote,
          t.locationText,
          t.accountId,
          a.accountName,
          t.categoryId,
          c.categoryName,
          img.imageUrl
        FROM dbo.cm_Transactions t
        INNER JOIN dbo.cm_Accounts a
          ON a.accountId = t.accountId
         AND a.userId = @uid
         AND ISNULL(a.isDelete, 0) = 0
        LEFT JOIN dbo.cm_Categories c
          ON c.categoryId = t.categoryId
         AND ISNULL(c.isDelete, 0) = 0
        OUTER APPLY (
          SELECT TOP 1 ti.imageUrl
          FROM dbo.cm_TransactionImages ti
          WHERE ti.transactionId = t.transactionId
            AND ISNULL(ti.isDelete, 0) = 0
          ORDER BY ti.displayOrder ASC, ti.transactionImageId ASC
        ) img
        WHERE ISNULL(t.isDelete, 0) = 0
          AND t.userId = @uid
          AND CAST(t.transactionDate AS DATE) BETWEEN @startDate AND @endDate
          AND img.imageUrl IS NOT NULL
          AND (
            @accId IS NULL AND (@accType IS NULL OR a.accountType = @accType)
            OR
            @accId IS NOT NULL AND t.accountId = @accId
          )
        ORDER BY t.transactionDate ASC, t.transactionId ASC;
      `);

    res.json({ success: true, data: r.recordset || [] });
  } catch (err) {
    console.error('capmoney transactions/by-month error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== DELETE: /transactions/:transactionId ==================
// Soft delete transaction + revert account balance + soft delete images
router.delete('/transactions/:transactionId', requireAuth, async (req, res) => {
  let tx;
  try {
    const uid = req.user.userID;
    const transactionId = Number(req.params.transactionId);
    if (!Number.isFinite(transactionId) || transactionId <= 0) {
      return res.status(400).json({ success: false, message: 'transactionId không hợp lệ' });
    }

    const pool = await poolPromise;
    tx = new sql.Transaction(pool);
    await tx.begin();

    // Load transaction (owned by user)
    const rTx = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .query(`
        SELECT TOP 1
          t.transactionId,
          t.userId,
          t.transactionTypeId,
          t.accountId,
          t.amount,
          ISNULL(t.isDelete, 0) AS isDelete
        FROM dbo.cm_Transactions t
        WHERE t.transactionId = @transactionId
          AND t.userId = @uid
      `);

    const row = rTx.recordset?.[0];
    if (!row) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Giao dịch không tồn tại' });
    }
    if (Number(row.isDelete) === 1) {
      await tx.rollback();
      return res.json({ success: true, message: 'Giao dịch đã được xóa trước đó' });
    }

    const accId = Number(row.accountId);
    const amountNum = Number(row.amount || 0);
    const typeId = Number(row.transactionTypeId);

    // Revert balance: expense had -amount, so revert is +amount; income had +amount, revert is -amount
    const revert = typeId === 1 ? amountNum : typeId === 2 ? -amountNum : 0;

    await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .query(`
        UPDATE dbo.cm_Transactions
        SET isDelete = 1,
            updatedBy = @uid,
            updatedDate = SYSDATETIME()
        WHERE transactionId = @transactionId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0;
      `);

    // Soft delete images
    await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .query(`
        UPDATE dbo.cm_TransactionImages
        SET isDelete = 1
        WHERE transactionId = @transactionId
          AND ISNULL(isDelete, 0) = 0;
      `);

    // Update balance
    if (revert !== 0 && Number.isFinite(accId) && accId > 0) {
      await new sql.Request(tx)
        .input('uid', sql.Int, uid)
        .input('accountId', sql.Int, accId)
        .input('delta', sql.Decimal(18, 2), revert)
        .query(`
          UPDATE dbo.cm_Accounts
          SET currentBalance = ISNULL(currentBalance, 0) + @delta,
              updatedDate = SYSDATETIME(),
              updatedBy = @uid
          WHERE accountId = @accountId
            AND userId = @uid
            AND ISNULL(isDelete, 0) = 0;
        `);
    }

    await tx.commit();
    return res.json({ success: true, message: 'Đã xóa giao dịch' });
  } catch (err) {
    console.error('capmoney transactions delete error:', err);
    try {
      if (tx) await tx.rollback();
    } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== PUT: /transactions/:transactionId/image ==================
// Replace transaction image (soft delete old + insert new)
router.put('/transactions/:transactionId/image', requireAuth, upload.single('image'), async (req, res) => {
  let tx;
  try {
    const uid = req.user.userID;
    const transactionId = Number(req.params.transactionId);
    if (!Number.isFinite(transactionId) || transactionId <= 0) {
      return res.status(400).json({ success: false, message: 'transactionId không hợp lệ' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: 'Thiếu file image' });
    }
    const mime = (file.mimetype || '').toLowerCase();
    const ext = getExtLower(file.originalname);
    if (!mime.startsWith('image/') || BLOCKED_MIMES.has(mime) || BLOCKED_EXTS.has(ext)) {
      return res.status(400).json({ success: false, message: 'File không hợp lệ' });
    }

    const pool = await poolPromise;
    tx = new sql.Transaction(pool);
    await tx.begin();

    // Validate ownership + not deleted
    const rTx = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .query(`
        SELECT TOP 1 transactionId
        FROM dbo.cm_Transactions
        WHERE transactionId = @transactionId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0
      `);
    if (!rTx.recordset?.length) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Giao dịch không tồn tại' });
    }

    const uploadRoot = process.env.UPLOAD_ROOT || 'D:/uploads';
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://api.thuanhunglongan.com';

    const relDir = `/uploads/images/capmoney/${transactionId}`;
    const absDir = path.join(uploadRoot, 'images', 'capmoney', String(transactionId));
    await fs.ensureDir(absDir);

    const storedName = makeSafeStoredName(file.originalname);
    const absPath = path.join(absDir, storedName);
    await fs.writeFile(absPath, file.buffer);

    const storagePath = `${relDir}/${storedName}`;
    const imageUrl = `${String(publicBaseUrl).replace(/\/$/, '')}${storagePath}`;

    // Soft delete old images
    await new sql.Request(tx)
      .input('transactionId', sql.BigInt, transactionId)
      .query(`
        UPDATE dbo.cm_TransactionImages
        SET isDelete = 1
        WHERE transactionId = @transactionId
          AND ISNULL(isDelete, 0) = 0;
      `);

    // Insert new image as primary
    await new sql.Request(tx)
      .input('transactionId', sql.BigInt, transactionId)
      .input('imageUrl', sql.NVarChar(500), imageUrl)
      .input('imageName', sql.NVarChar(255), sanitizeFileName(file.originalname))
      .input('imageType', sql.NVarChar(100), file.mimetype)
      .input('fileSize', sql.BigInt, file.size)
      .input('displayOrder', sql.Int, 1)
      .input('createdBy', sql.Int, uid)
      .query(`
        INSERT INTO dbo.cm_TransactionImages
          (transactionId, imageUrl, imageName, imageType, fileSize,
           displayOrder, createdBy, createdDate, isDelete)
        VALUES
          (@transactionId, @imageUrl, @imageName, @imageType, @fileSize,
           @displayOrder, @createdBy, GETDATE(), 0);
      `);

    await tx.commit();
    return res.json({ success: true, data: { transactionId, imageUrl } });
  } catch (err) {
    console.error('capmoney transactions replace-image error:', err);
    try {
      if (tx) await tx.rollback();
    } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== PUT: /transactions/:transactionId/date ==================
// Update transaction date (YYYY-MM-DD)
router.put('/transactions/:transactionId/date', requireAuth, async (req, res) => {
  try {
    const uid = req.user.userID;
    const transactionId = Number(req.params.transactionId);
    const { transactionDate } = req.body || {};

    if (!Number.isFinite(transactionId) || transactionId <= 0) {
      return res.status(400).json({ success: false, message: 'transactionId không hợp lệ' });
    }
    if (!transactionDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(transactionDate))) {
      return res.status(400).json({ success: false, message: 'transactionDate phải là YYYY-MM-DD' });
    }

    const pool = await poolPromise;
    const r = await pool
      .request()
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .input('transactionDate', sql.Date, String(transactionDate))
      .query(`
        UPDATE dbo.cm_Transactions
        SET transactionDate = @transactionDate,
            updatedBy = @uid,
            updatedDate = SYSDATETIME()
        WHERE transactionId = @transactionId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0;

        SELECT @@ROWCOUNT AS affected;
      `);

    const affected = Number(r.recordset?.[0]?.affected || 0);
    if (!affected) {
      return res.status(404).json({ success: false, message: 'Giao dịch không tồn tại' });
    }

    return res.json({ success: true, data: { transactionId, transactionDate } });
  } catch (err) {
    console.error('capmoney transactions update-date error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== PUT: /transactions/:transactionId/category ==================
// Update category (and transactionType based on category.transactionTypeId). Also adjusts account balance if type changes.
router.put('/transactions/:transactionId/category', requireAuth, async (req, res) => {
  let tx;
  try {
    const uid = req.user.userID;
    const transactionId = Number(req.params.transactionId);
    const { categoryId } = req.body || {};
    const catId = Number(categoryId);

    if (!Number.isFinite(transactionId) || transactionId <= 0) {
      return res.status(400).json({ success: false, message: 'transactionId không hợp lệ' });
    }
    if (!Number.isFinite(catId) || catId <= 0) {
      return res.status(400).json({ success: false, message: 'categoryId không hợp lệ' });
    }

    const pool = await poolPromise;
    tx = new sql.Transaction(pool);
    await tx.begin();

    // Load transaction
    const rTx = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .query(`
        SELECT TOP 1
          transactionId,
          transactionTypeId,
          accountId,
          amount
        FROM dbo.cm_Transactions
        WHERE transactionId = @transactionId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0
      `);
    const t = rTx.recordset?.[0];
    if (!t) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Giao dịch không tồn tại' });
    }

    // Load category (must belong to user)
    const rCat = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('categoryId', sql.Int, catId)
      .query(`
        SELECT TOP 1
          categoryId,
          categoryName,
          transactionTypeId,
          categoryIcon,
          categoryColor
        FROM dbo.cm_Categories
        WHERE categoryId = @categoryId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0
      `);
    const c = rCat.recordset?.[0];
    if (!c) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Danh mục không tồn tại' });
    }

    const oldType = Number(t.transactionTypeId);
    const newType = Number(c.transactionTypeId);
    const amountNum = Number(t.amount || 0);
    const accId = Number(t.accountId);

    // Adjust balance if type changes (expense=-1, income=+1)
    if (oldType !== newType && [1, 2].includes(oldType) && [1, 2].includes(newType)) {
      const oldSign = oldType === 1 ? -1 : 1;
      const newSign = newType === 1 ? -1 : 1;
      const delta = (newSign - oldSign) * amountNum; // e.g. -1 -> +1 => +2*amount
      await new sql.Request(tx)
        .input('uid', sql.Int, uid)
        .input('accountId', sql.Int, accId)
        .input('delta', sql.Decimal(18, 2), delta)
        .query(`
          UPDATE dbo.cm_Accounts
          SET currentBalance = ISNULL(currentBalance, 0) + @delta,
              updatedDate = SYSDATETIME(),
              updatedBy = @uid
          WHERE accountId = @accountId
            AND userId = @uid
            AND ISNULL(isDelete, 0) = 0;
        `);
    }

    await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .input('categoryId', sql.Int, catId)
      .input('transactionTypeId', sql.Int, newType)
      .query(`
        UPDATE dbo.cm_Transactions
        SET categoryId = @categoryId,
            transactionTypeId = @transactionTypeId,
            updatedBy = @uid,
            updatedDate = SYSDATETIME()
        WHERE transactionId = @transactionId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0;
      `);

    await tx.commit();
    return res.json({
      success: true,
      data: {
        transactionId,
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        categoryIcon: c.categoryIcon,
        categoryColor: c.categoryColor,
        transactionTypeId: newType,
      },
    });
  } catch (err) {
    console.error('capmoney transactions update-category error:', err);
    try {
      if (tx) await tx.rollback();
    } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================== PUT: /transactions/:transactionId/account ==================
// Update accountId and adjust balances accordingly
router.put('/transactions/:transactionId/account', requireAuth, async (req, res) => {
  let tx;
  try {
    const uid = req.user.userID;
    const transactionId = Number(req.params.transactionId);
    const { accountId } = req.body || {};
    const newAccId = Number(accountId);

    if (!Number.isFinite(transactionId) || transactionId <= 0) {
      return res.status(400).json({ success: false, message: 'transactionId không hợp lệ' });
    }
    if (!Number.isFinite(newAccId) || newAccId <= 0) {
      return res.status(400).json({ success: false, message: 'accountId không hợp lệ' });
    }

    const pool = await poolPromise;
    tx = new sql.Transaction(pool);
    await tx.begin();

    // Load transaction
    const rTx = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .query(`
        SELECT TOP 1
          transactionId,
          transactionTypeId,
          accountId,
          amount
        FROM dbo.cm_Transactions
        WHERE transactionId = @transactionId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0
      `);
    const t = rTx.recordset?.[0];
    if (!t) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Giao dịch không tồn tại' });
    }

    const oldAccId = Number(t.accountId);
    if (oldAccId === newAccId) {
      await tx.rollback();
      return res.json({ success: true, data: { transactionId, accountId: newAccId } });
    }

    // Validate new account belongs to user
    const rAcc = await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('accountId', sql.Int, newAccId)
      .query(`
        SELECT TOP 1 accountId, accountName
        FROM dbo.cm_Accounts
        WHERE accountId = @accountId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0
      `);
    const aNew = rAcc.recordset?.[0];
    if (!aNew) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Tài khoản không tồn tại' });
    }

    const typeId = Number(t.transactionTypeId);
    const amountNum = Number(t.amount || 0);
    const sign = typeId === 1 ? -1 : typeId === 2 ? 1 : 0;
    const deltaOld = -sign * amountNum; // revert old
    const deltaNew = sign * amountNum; // apply to new

    // Update balances
    if (sign !== 0) {
      await new sql.Request(tx)
        .input('uid', sql.Int, uid)
        .input('accountId', sql.Int, oldAccId)
        .input('delta', sql.Decimal(18, 2), deltaOld)
        .query(`
          UPDATE dbo.cm_Accounts
          SET currentBalance = ISNULL(currentBalance, 0) + @delta,
              updatedDate = SYSDATETIME(),
              updatedBy = @uid
          WHERE accountId = @accountId
            AND userId = @uid
            AND ISNULL(isDelete, 0) = 0;
        `);

      await new sql.Request(tx)
        .input('uid', sql.Int, uid)
        .input('accountId', sql.Int, newAccId)
        .input('delta', sql.Decimal(18, 2), deltaNew)
        .query(`
          UPDATE dbo.cm_Accounts
          SET currentBalance = ISNULL(currentBalance, 0) + @delta,
              updatedDate = SYSDATETIME(),
              updatedBy = @uid
          WHERE accountId = @accountId
            AND userId = @uid
            AND ISNULL(isDelete, 0) = 0;
        `);
    }

    // Update transaction
    await new sql.Request(tx)
      .input('uid', sql.Int, uid)
      .input('transactionId', sql.BigInt, transactionId)
      .input('accountId', sql.Int, newAccId)
      .query(`
        UPDATE dbo.cm_Transactions
        SET accountId = @accountId,
            updatedBy = @uid,
            updatedDate = SYSDATETIME()
        WHERE transactionId = @transactionId
          AND userId = @uid
          AND ISNULL(isDelete, 0) = 0;
      `);

    await tx.commit();
    return res.json({
      success: true,
      data: { transactionId, accountId: newAccId, accountName: aNew.accountName },
    });
  } catch (err) {
    console.error('capmoney transactions update-account error:', err);
    try {
      if (tx) await tx.rollback();
    } catch {}
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});