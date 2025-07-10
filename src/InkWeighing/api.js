const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");


const parseDateStrToDateSQLFormat = (str) => {
  if (!str) throw new Error('Ngày bị undefined');

  const parts = str.replace(/-/g, '/').split('/');
  if (parts.length !== 3) throw new Error(`Ngày không hợp lệ: ${str}`);

  const [day, month, year] = parts;
  const fullYear = year.length === 2 ? parseInt(`20${year}`) : parseInt(year);

  // ✅ Tạo ngày local tại múi giờ Việt Nam và format chuẩn SQL (yyyy-MM-dd)
  const luxonDate = DateTime.fromObject(
    { day: +day, month: +month, year: fullYear },
    { zone: 'Asia/Ho_Chi_Minh' }
  );

  return luxonDate.toFormat('yyyy-MM-dd'); // trả về string
};

// Helper xử lý giờ nếu thiếu giây (vd: "15:40" => "15:40:00")
const formatTimeStr = (str) => {
  const parts = str.trim().split(':');
  if (parts.length === 2) return str + ':00'; // Thêm giây nếu thiếu
  return str;
};

const parseTimeToDateObject = (timeStr) => {
  const [h, m, s] = timeStr.split(':').map(Number);
  const d = new Date(0); // 👈 Đây là điểm mấu chốt
  d.setUTCHours(h);
  d.setUTCMinutes(m);
  d.setUTCSeconds(s || 0);
  d.setUTCMilliseconds(0);
  return d;
};


function apiInkWeighing(app) {

    app.post('/api/scale/data', async (req, res) => {
    const data = req.body;
    const rawText = JSON.stringify(data);
    const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

    let transaction;
    try {
        const pool = await poolPromise;
        transaction = new sql.Transaction(pool);

        // Lưu log ban đầu (không lỗi)
        await pool.request()
            .input('raw_text', sql.NVarChar(sql.MAX), rawText)
            .input('received_at', sql.DateTime, nowVN)
            .input('error_message', sql.NVarChar(sql.MAX), null)
            .query(`
                INSERT INTO Logfiles (raw_text, received_at, error_message)
                VALUES (@raw_text, @received_at, @error_message)
            `);

        await transaction.begin();

        // Parse hskt thành các trường riêng
        const [operationCode, department, unit, workShift, hsktId] = data.hskt.split("~");

        // Parse thời gian
        const [startTimeStr, weighStartDateStr] = data.hskt_time.split("~");
        const [endTimeStr, weighEndDateStr] = data.finish_time.split("~");

        const startTime = formatTimeStr(startTimeStr);
        const endTime = formatTimeStr(endTimeStr);
        const weighStartDate = parseDateStrToDateSQLFormat(weighStartDateStr);
        const weighEndDate = parseDateStrToDateSQLFormat(weighEndDateStr);

        console.log(weighStartDate);

        // Lưu vào bảng WeighingSessions
        const sessionResult = await pool.request()
            .input('hskt', sql.NVarChar, data.hskt)
            .input('hsktId', sql.NVarChar, hsktId)
            .input('operationCode', sql.NVarChar, operationCode)
            .input('department', sql.NVarChar, department)
            .input('unit', sql.NVarChar, unit)
            .input('workShift', sql.NVarChar, workShift)
            .input('scaleCode', sql.NVarChar, data.scale_id)
            .input('startTime', sql.Time, parseTimeToDateObject(startTime))
            .input('weighStartDate', sql.Date, weighStartDate)
            .input('endTime', sql.Time, parseTimeToDateObject(endTime))
            .input('weighEndDate', sql.Date, weighEndDate)
            .input('deliveredBy', sql.NVarChar, null)
            .input('receivedBy', sql.NVarChar, null)
            .query(`
                INSERT INTO WeighingSessions
                (hskt, hsktId, startTime, weighStartDate, endTime, weighEndDate,
                 workShift, operationCode, department, unit, scaleCode, deliveredBy, receivedBy)
                OUTPUT INSERTED.weighingSessionId
                VALUES
                (@hskt, @hsktId, @startTime, @weighStartDate, @endTime, @weighEndDate,
                 @workShift, @operationCode, @department, @unit, @scaleCode, @deliveredBy, @receivedBy)
            `);

        const sessionId = sessionResult.recordset[0].weighingSessionId;

        // Lưu các item
        for (const item of data.items) {
            if (!item.color || !item.weight) throw new Error('Thiếu dữ liệu color hoặc weight');

            const [weightBinStr, inkCode, inkName, nsxStr] = item.color.split("~");
            const weight = parseFloat(item.weight);
            const weightBin = parseFloat(weightBinStr);
            const productionDate = parseDateStrToDateSQLFormat(nsxStr);

            await pool.request()
                .input('sessionId', sql.Int, sessionId)
                .input('inkCode', sql.NVarChar, inkCode)
                .input('inkName', sql.NVarChar, inkName)
                .input('productionDate', sql.Date, productionDate)
                .input('weight', sql.Float, weight)
                .input('weightBin', sql.Float, weightBin)
                .query(`
                    INSERT INTO WeighingSessionItems
                    (sessionId, inkCode, inkName, productionDate, weight, weightBin)
                    VALUES (@sessionId, @inkCode, @inkName, @productionDate, @weight, @weightBin)
                `);
        }

        await transaction.commit();
        res.status(200).json({ message: 'Lưu phiên cân thành công' });

    } catch (err) {
        if (transaction) await transaction.rollback();
        console.error('Lỗi khi lưu log:', err);

        // Ghi lỗi vào Logfiles
        try {
            const pool = await poolPromise;
            await pool.request()
                .input('raw_text', sql.NVarChar(sql.MAX), rawText)
                .input('received_at', sql.DateTime, nowVN)
                .input('error_message', sql.NVarChar(sql.MAX), err.message)
                .query(`
                    INSERT INTO Logfiles (raw_text, received_at, error_message)
                    VALUES (@raw_text, @received_at, @error_message)
                `);
        } catch (logErr) {
            console.error('Không thể ghi lỗi vào bảng log:', logErr);
        }

        res.status(500).json({ error: 'Lỗi khi xử lý và ghi log' });
    }
});


    app.get('/api/logfile', async (req, res) => {
        try {
            const { from, to } = req.query;
            const pool = await poolPromise;

            let query = `
            SELECT [logfileId], [raw_text], [received_at], [error_message]
            FROM Logfiles
            `;

            if (from && to) {
            query += `WHERE received_at BETWEEN @from AND @to `;
            }

            query += `ORDER BY received_at DESC`;

            const request = pool.request();
            if (from && to) {
            request.input('from', sql.DateTime, new Date(from));
            request.input('to', sql.DateTime, new Date(to + 'T23:59:59'));
            }

            const result = await request.query(query);
            res.json(result.recordset);
        } catch (err) {
            console.error('Lỗi khi lấy dữ liệu log:', err);
            res.status(500).json({ error: 'Lỗi server khi lấy log' });
        }
    });

    app.get('/api/ink-weighing/history', async (req, res) => {
    try {
        const {
            date,
            shift,
            department,
            unit,
            operation,
            page = 1,
            pageSize = 10,
        } = req.query;

        const pool = await poolPromise;
        const offset = (page - 1) * pageSize;

        // 1. Tạo request 1 cho COUNT
        const countRequest = pool.request();
        countRequest.input('date', sql.Date, date?.trim() || null);
        countRequest.input('shift', sql.NVarChar, shift?.trim() || null);
        countRequest.input('department', sql.VarChar, department?.trim() || null);
        countRequest.input('unit', sql.VarChar, unit?.trim() || null);
        countRequest.input('operation', sql.VarChar, operation?.trim() || null);

        const countResult = await countRequest.query(`
            SELECT COUNT(DISTINCT weighingSessionId) AS total
            FROM WeighingSessions
            WHERE
                (@date IS NULL OR weighStartDate = @date) AND
                (@shift IS NULL OR workShift = @shift) AND
                (@department IS NULL OR department = @department) AND
                (@unit IS NULL OR unit = @unit) AND
                (@operation IS NULL OR operationCode = @operation)
        `);

        const total = countResult.recordset[0].total;
        const totalPages = Math.ceil(total / pageSize);

        // 2. Tạo request 2 cho SELECT có phân trang
        const listRequest = pool.request();
        listRequest.input('date', sql.Date, date?.trim() || null);
        listRequest.input('shift', sql.NVarChar, shift?.trim() || null);
        listRequest.input('department', sql.VarChar, department?.trim() || null);
        listRequest.input('unit', sql.VarChar, unit?.trim() || null);
        listRequest.input('operation', sql.VarChar, operation?.trim() || null);
        listRequest.input('from', sql.Int, offset + 1);
        listRequest.input('to', sql.Int, offset + Number(pageSize));

        const pagedResult = await listRequest.query(`
            SELECT *
            FROM (
                SELECT *,
                    ROW_NUMBER() OVER (ORDER BY weighStartDate DESC, startTime DESC) AS row_num
                FROM WeighingSessions
                WHERE
                    (@date IS NULL OR weighStartDate = @date) AND
                    (@shift IS NULL OR workShift = @shift) AND
                    (@department IS NULL OR department = @department) AND
                    (@unit IS NULL OR unit = @unit) AND
                    (@operation IS NULL OR operationCode = @operation)
            ) AS paged
            WHERE row_num BETWEEN @from AND @to
        `);

        const sessions = pagedResult.recordset;
        if (sessions.length === 0) {
            return res.json({ items: [], totalPages, currentPage: +page });
        }

        // 3. Lấy danh sách item tương ứng
        const sessionIds = sessions.map(s => s.weighingSessionId);
        const itemsResult = await pool.request()
            .query(`
                SELECT *
                FROM WeighingSessionItems
                WHERE sessionId IN (${sessionIds.join(',')})
            `);

        // 4. Gộp item theo sessionId
        const itemsBySession = {};
        for (const item of itemsResult.recordset) {
            const sid = item.sessionId;
            if (!itemsBySession[sid]) itemsBySession[sid] = [];
            itemsBySession[sid].push(item);
        }

        const result = sessions.map(session => ({
            ...session,
            items: itemsBySession[session.weighingSessionId] || []
        }));

        res.json({
            items: result,
            totalPages,
            currentPage: +page
        });

    } catch (err) {
        console.error('Lỗi lấy lịch sử cân mực:', err);
        res.status(500).json({ error: 'Lỗi server khi truy vấn lịch sử cân mực' });
    }
});



}

module.exports = {
    apiInkWeighing,
}