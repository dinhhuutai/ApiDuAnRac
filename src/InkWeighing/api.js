const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");

const formatDateStr = (str) => {
  const [day, month, year] = str.split("/");
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
// Chuyển '26/06/25' hoặc '2025-06-26' thành object Date
const parseDateStrToDateObject = (str) => {
  if (!str) throw new Error('Ngày bị undefined');
  const parts = str.replace(/-/g, '/').split('/');
  if (parts.length !== 3) throw new Error(`Ngày không hợp lệ: ${str}`);
  const [day, month, year] = parts;
  const fullYear = year.length === 2 ? parseInt(`20${year}`) : parseInt(year);
  return new Date(fullYear, parseInt(month) - 1, parseInt(day));
};

// Helper xử lý giờ nếu thiếu giây (vd: "15:40" => "15:40:00")
const formatTimeStr = (str) => {
  const parts = str.trim().split(':');
  if (parts.length === 2) return str + ':00'; // Thêm giây nếu thiếu
  return str;
};

const parseTimeToDateObject = (timeStr) => {
  const [h, m, s] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h);
  d.setMinutes(m);
  d.setSeconds(s || 0);
  d.setMilliseconds(0);
  return d;
}


function apiInkWeighing(app) {

    app.post('/api/scale/data', async (req, res) => {
        
        const data = req.body;
        const rawText = JSON.stringify(data);
        const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

        let transaction;
        try {
            const pool = await poolPromise;
            transaction = new sql.Transaction(pool);

            await pool.request()
            .input('raw_text', sql.NVarChar(sql.MAX), rawText)
            .input('received_at', sql.DateTime, nowVN)
            .input('error_message', sql.NVarChar(sql.MAX), null) // Nếu có lỗi thì thay đổi sau
            .query(`
                INSERT INTO Logfiles (raw_text, received_at, error_message)
                VALUES (@raw_text, @received_at, @error_message)
            `);

            await transaction.begin();
            // 1. Parse hskt
            const [operation, department, unit, workShift] = data.hskt.split("~");

            // 2. Parse hskt_time and finish_time
            const [startTimeStr, weighStartDateStr] = data.hskt_time.split("~");
            const [endTimeStr, weighEndDateStr] = data.finish_time.split("~");

            const startTime = formatTimeStr(startTimeStr);
            const weighStartDate = parseDateStrToDateObject(weighStartDateStr);
            const endTime = formatTimeStr(endTimeStr);
            const weighEndDate = parseDateStrToDateObject(weighEndDateStr);

            const sessionResult = await pool.request()
            .input('hskt', sql.NVarChar, data.hskt)
            .input('operation', sql.NVarChar, operation)
            .input('department', sql.VarChar, department)
            .input('unit', sql.VarChar, unit)
            .input('workShift', sql.NVarChar, workShift)
            .input('startTime', sql.Time, parseTimeToDateObject(startTime))
            .input('weighStartDate', sql.Date, weighStartDate)
            .input('endTime', sql.Time, parseTimeToDateObject(endTime))
            .input('weighEndDate', sql.Date, weighEndDate)
            .query(`
                INSERT INTO WeighingSessions
                (hskt, operation, startTime, weighStartDate, endTime, weighEndDate, workShift, department, unit)
                OUTPUT INSERTED.weighingSessionId
                VALUES
                (@hskt, @operation, @startTime, @weighStartDate, @endTime, @weighEndDate, @workShift, @department, @unit)
            `);

            const sessionId = sessionResult.recordset[0].weighingSessionId;

            // 3. Insert into WeighingSessionItems
            for (const item of data.items) {
                if (!item.color || !item.weight) throw new Error('Thiếu dữ liệu color hoặc weight trong item');

                const colorParts = item.color.split("~");
                if (colorParts.length !== 4) throw new Error('Định dạng color không đúng');
                                
                const [weightBinStr, inkCode, inkName, nsxStr] = item.color.split("~");
                const weight = parseFloat(item.weight);
                const weightBin = parseFloat(weightBinStr);
                const productionDate = parseDateStrToDateObject(nsxStr);

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
            const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('yyyy-MM-dd HH:mm:ss');

            // Nếu lỗi, vẫn ghi lại log nhưng có thêm error_message
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
            const request = pool.request();

            // Chuyển chuỗi rỗng thành null để dùng IS NULL trong SQL
            const safeDate = date?.trim() || null;
            const safeShift = shift?.trim() || null;
            const safeDepartment = department?.trim() || null;
            const safeUnit = unit?.trim() || null;
            const safeOperation = operation?.trim() || null;

            request.input('date', sql.Date, safeDate);
            request.input('shift', sql.NVarChar, safeShift);
            request.input('department', sql.VarChar, safeDepartment);
            request.input('unit', sql.VarChar, safeUnit);
            request.input('operation', sql.VarChar, safeOperation);

            const offset = (page - 1) * pageSize;

            // Lấy tổng số bản ghi phù hợp
            const countResult = await request.query(`
                SELECT COUNT(DISTINCT weighingSessionId) AS total
                FROM WeighingSessions
                WHERE
                    (@date IS NULL OR weighStartDate = @date) AND
                    (@shift IS NULL OR workShift = @shift) AND
                    (@department IS NULL OR department = @department) AND
                    (@unit IS NULL OR unit = @unit) AND
                    (@operation IS NULL OR operation = @operation)
            `);
            const total = countResult.recordset[0].total;
            const totalPages = Math.ceil(total / pageSize);

            // Truy vấn danh sách các phiên cân phù hợp (có phân trang)
            const sessionsResult = await request.query(`
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
                        (@operation IS NULL OR operation = @operation)
                ) AS paged
                WHERE row_num BETWEEN ${offset + 1} AND ${offset + Number(pageSize)}
            `);

            const sessions = sessionsResult.recordset;
            if (sessions.length === 0) {
                return res.json({ items: [], totalPages, currentPage: +page });
            }
            

            const sessionIds = sessions.map(s => s.weighingSessionId);
            if (sessionIds.length === 0) {
                return res.json({ items: [], totalPages, currentPage: +page });
            }

            // Truy vấn các item tương ứng
            const itemsResult = await pool.request().query(`
                SELECT *
                FROM WeighingSessionItems
                WHERE sessionId IN (${sessionIds.join(',')})
            `);

            // Gom item theo session
            const itemsBySession = {};
            for (const item of itemsResult.recordset) {
                const sid = item.sessionId;
                if (!itemsBySession[sid]) itemsBySession[sid] = [];
                itemsBySession[sid].push(item);
            }

            // Ghép dữ liệu lại
            const merged = sessions.map(session => ({
                ...session,
                items: itemsBySession[session.weighingSessionId] || []
            }));

            res.json({ items: merged, totalPages, currentPage: +page });
        } catch (err) {
            console.error('Lỗi lấy lịch sử cân mực:', err);
            res.status(500).json({ error: 'Lỗi server khi truy vấn lịch sử cân mực' });
        }
    });


}

module.exports = {
    apiInkWeighing,
}