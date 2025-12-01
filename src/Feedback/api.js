const { DateTime } = require('luxon');
const { sql, poolPromise } = require("../db");


const upload = require('../middleware/uploadMiddleware');


function apiFeedback(app) {

    app.post('/api/feedbacks', upload.array('images'), async (req, res) => {
  const content = req.body.content;
  const files = req.files; // array
  const imagePaths = files.map(file => `/uploads/${file.filename}`);
  const imageJson = JSON.stringify(imagePaths);

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('content', content)
      .input('imageUrls', imageJson)
      .query(`
        INSERT INTO Feedbacks (content, imageUrls, createdAt)
        VALUES (@content, @imageUrls, GETDATE())
      `);

    res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

    
app.get('/api/feedbacks', async (req, res) => {
  const { date } = req.query;

  try {
    const pool = await poolPromise;
    let result;

    if (date) {
      result = await pool.request()
        .input('date', sql.Date, date)
        .query(`
          SELECT * FROM Feedbacks 
          WHERE CAST(createdAt AS DATE) = @date
          ORDER BY createdAt DESC
        `);
    } else {
      result = await pool.request()
        .query(`SELECT * FROM Feedbacks ORDER BY createdAt DESC`);
    }

    const data = result.recordset.map(fb => ({
      ...fb,
      imageUrls: JSON.parse(fb.imageUrls || '[]'),
    }));

    res.json(data);
  } catch (err) {
    console.error('Lỗi truy vấn feedbacks:', err);
    res.status(500).json({ error: 'Failed to get feedbacks' });
  }
});


}

module.exports = {
    apiFeedback,
}