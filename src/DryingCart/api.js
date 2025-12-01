const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");


function apiDryingCart(app) {

    // cập nhật remainingSec theo endAtUtc (0 nếu đã quá giờ)
async function recalcRemaining(pool, cartId) {
  await pool.request()
    .input('cartId', sql.Int, cartId)
    .query(`
      UPDATE dbo.xpv_DryingCarts
      SET remainingSec =
        CASE
          WHEN endAtUtc IS NULL THEN remainingSec
          ELSE CASE WHEN DATEDIFF(SECOND, SYSUTCDATETIME(), endAtUtc) < 0
                THEN 0
                ELSE DATEDIFF(SECOND, SYSUTCDATETIME(), endAtUtc)
            END
        END,
          updatedAtUtc = SYSUTCDATETIME()
      WHERE cartId = @cartId;
    `);
}

    // GET /api/drying-carts?q=...   (tùy chọn q)
app.get('/api/drying-carts', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const pool = await poolPromise;
    if (!q) {
      const rs = await pool.request().query(`
        SELECT cartId, cartNumber, displayName, isActive,
               startAtUtc, endAtUtc, remainingSec, acknowledgedUtc,
               slotCode, status, createdAtUtc, updatedAtUtc,
               productCode, printLine
        FROM dbo.xpv_DryingCarts
        ORDER BY cartNumber
      `);
      return res.json(rs.recordset);
    }
    // search đơn giản theo mã/tên (case-insensitive, không dấu dùng COLLATE nếu cần)
    const rs = await pool.request()
      .input('kw', sql.NVarChar(100), `%${q}%`)
      .query(`
        SELECT cartId, cartNumber, displayName, isActive,
               startAtUtc, endAtUtc, remainingSec, acknowledgedUtc,
               slotCode, status, createdAtUtc, updatedAtUtc,
               productCode, printLine
        FROM dbo.xpv_DryingCarts
        WHERE CAST(cartNumber AS NVARCHAR(20)) LIKE @kw
           OR displayName LIKE @kw COLLATE Vietnamese_CI_AI
        ORDER BY cartNumber
      `);
    res.json(rs.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/drying/board
// Trả danh sách các xe đang nằm trong ô (slotCode NOT NULL), đã tính lại remainingSec
app.get('/api/drying/board', async (req, res) => {
  try {
    const pool = await poolPromise;

    // update remainingSec hàng loạt cho xe đang ở slot
    await pool.request().query(`
      UPDATE dbo.xpv_DryingCarts
      SET remainingSec =
        CASE
          WHEN endAtUtc IS NULL THEN remainingSec
          ELSE CASE WHEN DATEDIFF(SECOND, SYSUTCDATETIME(), endAtUtc) < 0
                THEN 0
                ELSE DATEDIFF(SECOND, SYSUTCDATETIME(), endAtUtc)
            END
        END,
          updatedAtUtc = SYSUTCDATETIME()
      WHERE slotCode IS NOT NULL;
    `);

    // trả về danh sách đang nằm trong ô
    const rs = await pool.request().query(`
      SELECT cartId, cartNumber, displayName, isActive,
             startAtUtc, endAtUtc, remainingSec, acknowledgedUtc,
             slotCode, status, createdAtUtc, updatedAtUtc,
               productCode, printLine
      FROM dbo.xpv_DryingCarts
      WHERE slotCode IS NOT NULL
      ORDER BY
        CASE WHEN remainingSec = 0 THEN 1 ELSE 0 END,  -- hết giờ cho xuống cuối (FE vẫn có modal)
        remainingSec ASC, cartNumber ASC;
    `);

    res.json(rs.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== THÊM TRONG function apiDryingCart(app) ======

// POST /api/drying-carts
// body: { cartNumber, displayName }
app.post('/api/drying-carts', async (req, res) => {
  try {
    const { cartNumber, displayName } = req.body || {};
    const num = Number(cartNumber);
    if (!num || !Number.isFinite(num)) {
      return res.status(400).json({ error: 'cartNumber (số) là bắt buộc' });
    }

    const pool = await poolPromise;

    // đảm bảo không trùng mã xe
    const rs = await pool.request()
      .input('cartNumber', sql.Int, num)
      .input('displayName', sql.NVarChar(200), displayName?.trim() || null)
      .query(`
        INSERT INTO dbo.xpv_DryingCarts(cartNumber, displayName, isActive, createdAtUtc, updatedAtUtc)
        VALUES(@cartNumber, @displayName, 1, SYSUTCDATETIME(), SYSUTCDATETIME());

        SELECT cartId, cartNumber, displayName, isActive, startAtUtc, endAtUtc, remainingSec,
               acknowledgedUtc, slotCode, status, createdAtUtc, updatedAtUtc,
               productCode, printLine
        FROM dbo.xpv_DryingCarts WHERE cartId = SCOPE_IDENTITY();
      `);

    res.status(201).json(rs.recordset[0]);
  } catch (e) {
    // 2601/2627: unique violation (nếu bạn có unique index cartNumber)
    if (e?.number === 2601 || e?.number === 2627) {
      return res.status(409).json({ error: 'Số xe đã tồn tại' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/drying-carts/:id  (hiện tại cho phép sửa displayName, isActive)
app.put('/api/drying-carts/:id', async (req, res) => {
  try {
    const cartId = Number(req.params.id);
    const { displayName, isActive } = req.body || {};
    const pool = await poolPromise;

    const rs = await pool.request()
      .input('cartId', sql.Int, cartId)
      .input('displayName', sql.NVarChar(100), displayName ?? null)
      .input('isActive', sql.Bit, typeof isActive === 'boolean' ? (isActive ? 1 : 0) : 1)
      .query(`
        UPDATE dbo.xpv_DryingCarts
        SET displayName = @displayName,
            isActive = @isActive,
            updatedAtUtc = SYSUTCDATETIME()
        WHERE cartId = @cartId;

        SELECT cartId, cartNumber, displayName, isActive,
               startAtUtc, endAtUtc, remainingSec, acknowledgedUtc,
               slotCode, status, createdAtUtc, updatedAtUtc,
               productCode, printLine
        FROM dbo.xpv_DryingCarts
        WHERE cartId = @cartId;
      `);

    res.json(rs.recordset[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/drying-carts/:id
app.delete('/api/drying-carts/:id', async (req, res) => {
  try {
    const cartId = Number(req.params.id);
    const pool = await poolPromise;

    // không cho xoá khi xe đang ở slot
    const chk = await pool.request()
      .input('cartId', sql.Int, cartId)
      .query(`SELECT slotCode FROM dbo.xpv_DryingCarts WHERE cartId=@cartId;`);

    if (!chk.recordset.length) return res.status(404).json({ error: 'Not found' });
    if (chk.recordset[0].slotCode) {
      return res.status(409).json({ error: 'Xe đang ở trong ô, hãy đưa về vị trí cũ trước khi xoá.' });
    }

    await pool.request()
      .input('cartId', sql.Int, cartId)
      .query(`DELETE FROM dbo.xpv_DryingCarts WHERE cartId=@cartId;`);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/drying/active  (nếu còn nơi dùng; tương tự /board nhưng chỉ xe đang active)
app.get('/api/drying/active', async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request().query(`
      UPDATE dbo.xpv_DryingCarts
      SET remainingSec =
        CASE
          WHEN endAtUtc IS NULL THEN remainingSec
          ELSE CASE WHEN DATEDIFF(SECOND, SYSUTCDATETIME(), endAtUtc) < 0
                THEN 0
                ELSE DATEDIFF(SECOND, SYSUTCDATETIME(), endAtUtc)
            END
        END,
          updatedAtUtc = SYSUTCDATETIME()
      WHERE slotCode IS NOT NULL;
    `);

    const rs = await pool.request().query(`
      SELECT cartId, cartNumber, displayName, startAtUtc, endAtUtc,
             remainingSec, acknowledgedUtc, slotCode,
               productCode, printLine
      FROM dbo.xpv_DryingCarts
      WHERE slotCode IS NOT NULL
      ORDER BY
        CASE WHEN remainingSec = 0 THEN 1 ELSE 0 END,
        remainingSec ASC, cartNumber ASC;
    `);
    res.json(rs.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// POST /api/drying/start
// body: { cartId, durationSec, slotCode }
app.post('/api/drying/start', async (req, res) => {
  try {
    const { cartId, durationSec, slotCode, productCode, printLine } = req.body || {};
    if (!cartId || !durationSec || !slotCode) {
      return res.status(400).json({ error: 'cartId, durationSec, slotCode required' });
    }

    const pool = await poolPromise;
    const startAt = new Date();
    const endAt   = new Date(startAt.getTime() + durationSec * 1000);

    // lock ô bằng unique index
    const rs = await pool.request()
      .input('cartId', sql.Int, cartId)
      .input('startAt', sql.DateTime2, startAt)
      .input('endAt', sql.DateTime2, endAt)
      .input('remain', sql.Int, durationSec)
      .input('slotCode', sql.NVarChar(20), slotCode)
      .input('productCode', sql.NVarChar(100), productCode || null)
      .input('printLine', sql.NVarChar(100), printLine || null)
      .query(`
        UPDATE dbo.xpv_DryingCarts
        SET startAtUtc=@startAt, endAtUtc=@endAt, remainingSec=@remain,
            acknowledgedUtc=NULL, slotCode=@slotCode, updatedAtUtc=SYSUTCDATETIME(),
            productCode = @productCode,
            printLine = @printLine
        WHERE cartId=@cartId;

        SELECT * FROM dbo.xpv_DryingCarts WHERE cartId=@cartId;
      `);

    res.json(rs.recordset[0]);
  } catch (e) {
    // nếu đụng unique slot, báo lỗi thân thiện
    if (e?.number === 2601 || e?.number === 2627) {
      return res.status(409).json({ error: 'Ô này đã chứa 1 xe khác. Vui lòng chọn ô khác.' });
    }
    console.log(e)
    res.status(500).json({ error: e.message });
  }
});


// Cộng thêm thời gian
app.post('/api/drying/extend', async (req, res) => {
    try {
        const { cartId, addSec } = req.body;
        if (!cartId || !addSec) return res.status(400).json({ error: 'cartId & addSec required' });
        const pool = await poolPromise;
        await pool.request()
        .input('cartId', sql.Int, cartId)
        .input('addSec', sql.Int, addSec)
        .query(`
            UPDATE xpv_DryingCarts
            SET endAtUtc = DATEADD(SECOND, @addSec, endAtUtc), updatedAtUtc = SYSUTCDATETIME()
            WHERE cartId=@cartId;
        `);
        await recalcRemaining(pool, cartId);
        const rs = await pool.request().input('cartId', sql.Int, cartId)
        .query('SELECT * FROM xpv_DryingCarts WHERE cartId=@cartId');
        res.json(rs.recordset[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/drying/stop-return
// body: { cartId }  => remainingSec=0, endAt=now, acknowledge & slotCode=NULL
app.post('/api/drying/stop-return', async (req, res) => {
  try {
    const { cartId } = req.body || {};
    if (!cartId) return res.status(400).json({ error: 'cartId required' });

    const pool = await poolPromise;
    const rs = await pool.request()
      .input('cartId', sql.Int, cartId)
      .query(`
        UPDATE dbo.xpv_DryingCarts
        SET endAtUtc = SYSUTCDATETIME(),
            remainingSec = 0,
            acknowledgedUtc = SYSUTCDATETIME(),
            slotCode = NULL,
            productCode = NULL,
            printLine  = NULL,
            updatedAtUtc = SYSUTCDATETIME()
        WHERE cartId=@cartId;

        SELECT * FROM dbo.xpv_DryingCarts WHERE cartId=@cartId;
      `);
    res.json(rs.recordset[0]);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
}
});


}

module.exports = {
    apiDryingCart,
}