# Lưu tệp module 18 "Quản lý yêu cầu" trên server bk — hướng dẫn cài

Thư mục này **không chạy trong NOIBO**. Đây là bản để **chép sang API server bk** (`apiWebAppNoiBo`, cổng 5000, sv-backup 10.84.40.34):

```
ApiDuAnRac\apiWebAppNoiBo\src\QuanLyYeuCau\api.js   →   D:\THLA\API-canDAcapmuc\apiWebAppNoiBo\src\QuanLyYeuCau\api.js
```

## Cách chạy

```
Trình duyệt (mạng nào cũng được)
   │ https
   ▼
API NOIBO  https://api.thuanhunglongan.com  (171.237.176.73)        máy dev: API NOIBO chạy local
   │ http, có chữ ký HMAC                                              │
   ▼                                                                   ▼
http://118.69.134.179:5000/api/server/backup/quan-ly-yeu-cau      http://10.84.40.34:5000/api/server/backup/quan-ly-yeu-cau
   │ router văn phòng chuyển cổng 5000 (đã có sẵn cho MES)             │ (cùng mạng LAN)
   ▼                                                                   ▼
API server bk (apiWebAppNoiBo, cổng 5000) — router QuanLyYeuCau → lưu vào D:\THLA\QuanLyYeuCau
```

- **Không phải mở thêm cổng router, không cần tên miền/chứng chỉ** — dùng lại đúng đường MES đang dùng.
- Máy dev và máy chủ online chỉ khác 1 dòng `RQ_FILE_SERVER_URL` trong `.env` của API NOIBO.
- Mọi route (trừ `/health`) bắt buộc chữ ký HMAC bằng khoá chung (`QLYC_FILE_SECRET` = `RQ_FILE_SECRET`), lệch giờ tối đa 5 phút → người ngoài biết địa chỉ cũng không đọc/ghi được tệp. Không ghi đè tệp đã có, không nhận `.exe/.bat/.js/.msi…`.
- ⚠️ Đoạn API NOIBO ↔ server bk là HTTP qua Internet (giống MES ↔ ERP hiện nay): nội dung tệp không mã hoá trên đường truyền.

## Thư mục lưu

```
D:\THLA\QuanLyYeuCau\
├── HinhAnh\2026-10-08\Hoá đơn tháng 10.jpg       ← ảnh (jpg, png, gif, webp, bmp, heic, tif…)
├── TaiLieu\2026-10-08\Bảng kê vật tư.xlsx         ← Word, Excel, PDF, PowerPoint, txt, csv
├── Video\2026-10-08\…                              ← mp4, mov, webm, avi, mkv…
├── Khac\2026-10-08\…                               ← zip, rar, dwg, âm thanh… (còn lại)
└── _HeThong\                                       ← DÙNG NỘI BỘ — đừng xoá/sửa
    ├── anh-thu-nho\HinhAnh\2026-10-08\Hoá đơn tháng 10.jpg.jpg   (ảnh nhỏ ~480px để danh sách mở nhanh)
    ├── thong-tin\…\<tên>.json                                     (ai tải, lúc nào)
    └── tam\                                                       (tệp đang tải dở, tự dọn sau 1 ngày)
```

- Ngày theo giờ Việt Nam, dạng **năm-tháng-ngày** (Explorer sắp xếp đúng thứ tự).
- Tên tệp = **tên gốc** người dùng đặt. Trùng tên trong cùng ngày → `Tên (1).jpg`, `Tên (2).jpg`. Ký tự Windows cấm (`\ / : * ? " < > |`) đổi thành `_`.
- ⚠️ **Đừng đổi tên / di chuyển / xoá** tệp trong các thư mục này: web lưu đường dẫn (`HinhAnh/2026-10-08/Hoá đơn tháng 10.jpg`) — đổi là đề xuất mất ảnh.
- Thư mục tự tạo khi API khởi động / khi có tệp đầu tiên.

---

## Các bước cài

Lệnh PowerShell (đang ở cmd thì gõ `powershell` trước).

### Bước 1 — Khoá bí mật (đã tạo sẵn)

Claude đã tạo khoá và ghi vào `D:\THLA\DuAnRac\ApiDuAnRac\.env` trên **máy dev** (dòng `RQ_FILE_SECRET=…`, 64 ký tự). Mở file đó bằng Notepad, **chép giá trị** sau dấu `=` — dùng cho bước 2 và bước 5. Không gửi khoá qua chat/Zalo.

### Bước 2 — Server bk: chép code + sửa `index.js` + `.env`

Thư mục API: `D:\THLA\API-canDAcapmuc\apiWebAppNoiBo` (trên sv-backup).

1. **Sao lưu** trước: chép `src\index.js` thành `src\index.js.bak-2026-10-08`, `.env` thành `.env.bak-2026-10-08`.
2. Tạo thư mục `src\QuanLyYeuCau`, chép file `api.js` từ `ApiDuAnRac\apiWebAppNoiBo\src\QuanLyYeuCau\api.js` (máy dev) vào đó.
3. Mở `src\index.js`, thêm **1 dòng** ngay dưới dòng `app.use('/api/server/backup/ggSheet', …)` (khoảng dòng 41):
   ```js
   app.use('/api/server/backup/ggSheet', require('./GgSheet/api'));

   // Module 18 "Quản lý yêu cầu" (web NOIBO) — lưu tệp/ảnh vào D:\THLA\QuanLyYeuCau
   app.use('/api/server/backup/quan-ly-yeu-cau', require('./QuanLyYeuCau/api'));
   ```
4. Cũng trong `src\index.js`, ở **cuối file** sửa dòng
   ```js
   server.requestTimeout = 300000;
   ```
   thành
   ```js
   server.requestTimeout = 1800000; // 30 phút — tệp đính kèm lớn qua mạng chậm (module Quản lý yêu cầu)
   ```
   (5 phút có thể không đủ khi nhân viên tải tệp 50 MB bằng 4G yếu. Không ảnh hưởng các API khác.)
5. Mở `.env`, thêm vào cuối:
   ```
   QLYC_FILE_SECRET=<khoá 64 ký tự ở bước 1>
   QLYC_FILE_ROOT=D:\THLA\QuanLyYeuCau
   QLYC_MAX_FILE_MB=50
   ```
   Không để dấu cách / dấu nháy quanh giá trị.

### Bước 3 — Server bk: khởi động lại API

Khởi động lại API cổng 5000 **theo cách đang chạy nó** (MES in tem gián đoạn vài giây → làm lúc ít in tem):
- chạy bằng pm2: `pm2 list` → `pm2 restart <tên app>`;
- chạy trong cửa sổ cmd/PowerShell: bấm Ctrl+C, rồi `npm start` trong thư mục `apiWebAppNoiBo`.

Log khởi động **không** được có dòng `⚠️ [QuanLyYeuCau] chưa đặt QLYC_FILE_SECRET` (nếu có → bước 2.5 sai). Thư mục `D:\THLA\QuanLyYeuCau` (và `_HeThong`) phải tự xuất hiện.

Kiểm tra trên sv-backup:
```powershell
curl.exe -s http://127.0.0.1:5000/api/server/backup/quan-ly-yeu-cau/health
curl.exe -s http://127.0.0.1:5000/api/server/backup/mes/ping
```
Dòng 1 → `{"ok":true,"name":"NOIBO QuanLyYeuCau (server bk)",…}`; dòng 2 → `{"ok":true}` (MES vẫn chạy).

### Bước 4 — Máy dev: thử ngay ở local

`ApiDuAnRac\.env` máy dev đã có:
```
RQ_FILE_SERVER_URL=http://10.84.40.34:5000/api/server/backup/quan-ly-yeu-cau
RQ_FILE_SECRET=<khoá>
RQ_FILE_MAX_MB=50
```
Chạy API NOIBO local (`npm run dev`), mở `http://localhost:<PORT>/api/rq/files/health` → phải `"ok":true,"auth":true`. Mở web local → Quản lý yêu cầu → tạo đề xuất có đính kèm ảnh + Excel → xem `D:\THLA\QuanLyYeuCau\HinhAnh\<hôm nay>\` và `TaiLieu\<hôm nay>\` trên sv-backup.

### Bước 5 — Máy chủ online (171.237.176.73)

1. Kiểm đường đi (RDP vào máy chủ, PowerShell):
   ```powershell
   curl.exe -s --max-time 10 http://118.69.134.179:5000/api/server/backup/quan-ly-yeu-cau/health
   ```
   → `{"ok":true,…}`. (Đừng thử `10.84.40.34` từ máy chủ online — không vào thẳng được, xem sự cố MES 2026-08-11.)
2. `.env` của API NOIBO (thư mục chạy pm2: `pm2.cmd describe <tên-app>` → dòng `exec cwd`) — sao lưu rồi thêm:
   ```
   RQ_FILE_SERVER_URL=http://118.69.134.179:5000/api/server/backup/quan-ly-yeu-cau
   RQ_FILE_SECRET=<đúng khoá ở bước 1>
   RQ_FILE_MAX_MB=50
   ```
3. IIS của API mặc định chặn request > ~28,6 MB → nâng lên 100 MB (hoặc đặt `RQ_FILE_MAX_MB=25` thì khỏi):
   ```powershell
   & "$env:windir\system32\inetsrv\appcmd.exe" list site
   & "$env:windir\system32\inetsrv\appcmd.exe" set config "<ten-site-api>" -section:system.webServer/security/requestFiltering /requestLimits.maxAllowedContentLength:104857600
   ```
4. Deploy backend + frontend NOIBO bản mới, `pm2.cmd reload <tên-app>`.
5. Mở **https://api.thuanhunglongan.com/api/rq/files/health** → `"ok":true,"auth":true` là xong.

## Gỡ lỗi (đọc `/api/rq/files/health`)

| Thấy | Nguyên nhân |
|---|---|
| `"configured":false` | API NOIBO chưa nhận `RQ_FILE_*` (sai thư mục `.env`, chưa reload) |
| `"reachable":false` + `ECONNREFUSED` / `TIMEOUT` | API server bk không chạy, hoặc (máy chủ online) cổng 5000 router không thông — thử `http://118.69.134.179:5000/api/server/backup/mes/ping` |
| `Server bk chưa có API lưu tệp` | Chưa chép `api.js` / chưa thêm dòng `app.use` / chưa khởi động lại API server bk |
| `"auth":false` + `Chưa cấu hình QLYC_FILE_SECRET` | Thiếu dòng trong `.env` server bk, hoặc chưa khởi động lại |
| `"auth":false` + `Sai chữ ký` | `QLYC_FILE_SECRET` (server bk) ≠ `RQ_FILE_SECRET` (API NOIBO) |
| `"auth":false` + `lệch nhau … giây` | Giờ Windows 2 máy lệch > 5 phút → `w32tm /resync` |

Log server bk: mỗi tệp lưu in 1 dòng `[QuanLyYeuCau] lưu HinhAnh/2026-10-08/… <dung lượng> u<userId> <IP>`; request bị từ chối in `⛔ từ chối … — <lý do>`.

## Sao lưu

Tệp chỉ có ở `D:\THLA\QuanLyYeuCau` — hỏng ổ là mất. Nên sao lưu mỗi đêm sang ổ khác/NAS (Task Scheduler → Daily 23:00 → Start a program):
```
Program: robocopy
Arguments: D:\THLA\QuanLyYeuCau \\<NAS>\backup\QuanLyYeuCau /E /XO /R:1 /W:1 /XD tam /NP /LOG+:D:\THLA\QuanLyYeuCau_backup.log
```

## Ghi chú kỹ thuật (cho người sửa code)

- Giao thức phải khớp `ApiDuAnRac/src/RequestManagement/files.js`: chữ ký `X-Noibo-Sig = base64url(HMAC-SHA256(khoá, "s|<METHOD>|<req.originalUrl>|<X-Noibo-Ts>"))`; `KEY_RE` giống hệt 2 bên.
- Route (gốc `/api/server/backup/quan-ly-yeu-cau`): `GET /health` · `PUT /files?u=<userId>` (header `X-File-Name` = encodeURIComponent, `X-File-Type`) → `{ key, name, size, mime }` · `PUT /thumb?u=&key=` · `GET /file?key=[&thumb=1][&dl=1&n=]`.
- Không dùng thư viện ngoài Express (chỉ `fs`, `path`, `crypto`); lỗi trong module không làm sập API server bk (thiếu khoá → chỉ báo lỗi, các API MES/OQC vẫn chạy).
- Kiểm thử ở máy dev: `node tools/rq-files-test.js` (thư mục gốc NOIBO) — dựng "server bk" bằng Express 4 + đúng file này, 13 bài.
