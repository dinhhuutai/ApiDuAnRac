const XLSX = require('xlsx');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function removeQuietly(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.error('❌ Không xoá được file tạm:', p, e.message);
  }
}

async function convertExcelsToPdf(files) {
  const pdfPaths = [];

  // 1 Chrome cho mọi file (trước đây mỗi file 1 Chrome, ~150–300 MB/lần), và
  // luôn đóng Chrome + xoá file tạm kể cả khi lỗi — server chỉ có 4 GB RAM.
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const file of files) {
      const htmlPath = path.join(__dirname, '../uploads', `${file.filename}.html`);
      try {
        const workbook = XLSX.readFile(file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const htmlContent = XLSX.utils.sheet_to_html(sheet);
        fs.writeFileSync(htmlPath, htmlContent);

        const page = await browser.newPage();
        try {
          await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

          const pdfPath = path.join(__dirname, '../uploads', `${file.originalname}.pdf`);
          await page.pdf({ path: pdfPath, format: 'A4' });
          pdfPaths.push(pdfPath);
        } finally {
          await page.close();
        }
      } finally {
        removeQuietly(file.path);
        removeQuietly(htmlPath);
      }
    }
  } catch (err) {
    pdfPaths.forEach(removeQuietly);
    // xoá nốt file upload chưa kịp xử lý
    files.forEach((f) => removeQuietly(f.path));
    throw err;
  } finally {
    await browser.close();
  }

  // Nếu nhiều PDF, trả về file zip
  if (pdfPaths.length > 1) {
    const zipPath = path.join(__dirname, '../uploads', 'converted.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');

    archive.pipe(output);
    pdfPaths.forEach((pdf) => {
      archive.file(pdf, { name: path.basename(pdf) });
    });

    await archive.finalize();

    return new Promise((resolve, reject) => {
      output.on('close', () => {
        pdfPaths.forEach((f) => fs.unlinkSync(f));
        resolve({ filePath: zipPath, isZip: true });
      });
      archive.on('error', (err) => reject(err));
    });
  } else {
    const onlyPdf = pdfPaths[0];
    return { filePath: onlyPdf, isZip: false };
  }
}

module.exports = { convertExcelsToPdf };
