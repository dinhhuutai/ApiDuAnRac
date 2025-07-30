const XLSX = require('xlsx');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

async function convertExcelsToPdf(files) {
  const pdfPaths = [];

  for (const file of files) {
    const workbook = XLSX.readFile(file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const htmlContent = XLSX.utils.sheet_to_html(sheet);

    const htmlPath = path.join(__dirname, '../uploads', `${file.filename}.html`);
    fs.writeFileSync(htmlPath, htmlContent);

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

    const pdfPath = path.join(__dirname, '../uploads', `${file.originalname}.pdf`);
    await page.pdf({ path: pdfPath, format: 'A4' });

    await browser.close();
    fs.unlinkSync(file.path);
    fs.unlinkSync(htmlPath);

    pdfPaths.push(pdfPath);
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
