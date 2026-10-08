# Máy chủ tệp nội bộ NOIBO — hướng dẫn cài đặt

Dùng cho module 18 **Quản lý yêu cầu**: mọi tệp và ảnh đính kèm (đề xuất, bình luận, chat) được lưu trên **1 máy trong mạng công ty**, không lưu trên máy chủ Internet.

```
Điện thoại / máy tính nhân viên  (đang dùng Wi-Fi / mạng LAN công ty)
   │
   ├── https://noibo.thuanhunglongan.com      → giao diện web (Internet)
   ├── https://api.thuanhunglongan.com/api/rq → nội dung đề xuất, duyệt, bình luận, chat (Internet)
   │        └─ API chỉ cấp "vé tải lên" và ký đường dẫn xem tệp (có hạn)
   └── https://files.thuanhunglongan.com       → TẢI LÊN / XEM / TẢI VỀ tệp  ← MÁY NÀY (chỉ trong mạng công ty)
                                                  lưu ở D:\NOIBO_FILES\rq\<năm>\<tháng>\
```

- **Trong mạng công ty**: dùng đầy đủ — xem ảnh, tải tệp, đính kèm.
- **Ngoài mạng công ty (4G, Wi-Fi nhà)**: vẫn xem/duyệt/bình luận/chat bình thường, nhưng chỗ ảnh/tệp hiện *"Kết nối mạng công ty để xem"* và không đính kèm được.
- Tệp **không đi qua** máy chủ Internet (không tốn băng thông/ổ đĩa của máy chủ 4 GB RAM), tải lên/xuống trong LAN rất nhanh.
- Máy chủ tệp **không cần** kết nối SQL Server. Chỉ cần: Node.js, 1 thư mục lưu, 1 khoá bí mật dùng chung với API.

---

## 0. Chuẩn bị

| Hạng mục | Giá trị dùng trong hướng dẫn | Ghi chú |
|---|---|---|
| Máy chạy | **10.84.40.34** (máy chủ nội bộ đang chạy API nội bộ cổng 5000) | Máy Windows bật 24/7, IP **tĩnh**. Kiểm tra IP: `ipconfig`. Dùng máy khác thì thay IP ở mọi bước |
| Tên miền | **files.thuanhunglongan.com** | Tên miền công ty đang quản lý ở **PA Việt Nam** (pavietnam.vn) |
| Cổng | **443** (đang trống trên 10.84.40.34) | Nếu sau này có web khác dùng 443 thì đổi sang 8443 và thêm `:8443` vào mọi đường dẫn |
| Thư mục lưu | `D:\NOIBO_FILES` | Ổ dữ liệu, còn trống nhiều. Ảnh điện thoại ~2–5 MB/ảnh |
| Thư mục chương trình | `C:\NOIBO\fileserver` | Chép nguyên thư mục `ApiDuAnRac\fileserver` vào đây |

> **Vì sao phải có tên miền + HTTPS?** Trang web chạy `https://`, trình duyệt **chặn** ảnh/tệp lấy từ địa chỉ `http://` (mixed content) và không tin chứng chỉ tự ký trên điện thoại. Nên máy chủ tệp cần tên miền thật + chứng chỉ thật, dù chỉ dùng trong LAN.

---

## 1. Cài Node.js và chép chương trình (trên 10.84.40.34)

1. Tải **Node.js LTS** (bản 22 trở lên) tại https://nodejs.org → cài mặc định (tick "Add to PATH").
2. Chép thư mục `ApiDuAnRac\fileserver` thành `C:\NOIBO\fileserver`.
3. Mở **PowerShell (Run as Administrator)**:
   ```powershell
   node -v                                   # phải ra v22.x trở lên
   New-Item -ItemType Directory -Force D:\NOIBO_FILES, C:\NOIBO\certs
   cd C:\NOIBO\fileserver
   Copy-Item .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Lệnh cuối in ra 1 chuỗi 64 ký tự → đây là **khoá bí mật**. Lưu lại (dùng ở bước 1 và bước 6).
4. Mở `C:\NOIBO\fileserver\.env` bằng Notepad, điền `FILE_SECRET=<chuỗi 64 ký tự>`. Các dòng khác giữ như mẫu.

## 2. Tạo bản ghi DNS `files` trỏ vào IP nội bộ

Vào trang quản lý tên miền **PA Việt Nam** → `thuanhunglongan.com` → Quản lý DNS → **Thêm bản ghi**:

| Loại | Tên (Host) | Giá trị | TTL |
|---|---|---|---|
| A | `files` | `10.84.40.34` | 3600 |

- Tên miền hiện có bản ghi `*` (mọi tên con → 103.77.162.35). Bản ghi `files` cụ thể sẽ **được ưu tiên** hơn `*`.
- Trỏ tên miền công khai vào IP nội bộ là bình thường: người ngoài tra ra `10.84.40.34` nhưng **không vào được** (IP này chỉ có trong LAN công ty).
- Kiểm tra (sau 5–30 phút): `nslookup files.thuanhunglongan.com 8.8.8.8` → phải ra `10.84.40.34`.
- Một số router chặn tên miền trả về IP nội bộ ("DNS rebinding protection"). Nếu trong công ty `nslookup files.thuanhunglongan.com` (không có `8.8.8.8`) không ra `10.84.40.34`: tắt tính năng đó cho `thuanhunglongan.com` trên router, hoặc thêm bản ghi DNS nội bộ `files.thuanhunglongan.com → 10.84.40.34` trên router/DNS nội bộ.

## 3. Lấy chứng chỉ HTTPS (Let's Encrypt, miễn phí)

Máy 10.84.40.34 không nhận kết nối từ Internet nên phải xác minh tên miền bằng **DNS** (không dùng được cách HTTP như máy chủ chính). Dùng **win-acme** (công cụ đang dùng cho noibo/api).

1. Tải win-acme (`win-acme.v2.x.x.x64.pluggable.zip`) tại https://www.win-acme.com → giải nén vào `C:\NOIBO\win-acme`.
2. PowerShell (Administrator): `cd C:\NOIBO\win-acme; .\wacs.exe`
3. Chọn: **M** (Create certificate, full options) → **2** (Manual input) → nhập `files.thuanhunglongan.com`.
4. Cách xác minh — chọn một trong hai:
   - **Cách A — tự gia hạn (khuyên dùng):** chọn **acme-dns** → dùng server mặc định `https://auth.acme-dns.io` → win-acme in ra 1 bản ghi **CNAME**, ví dụ
     `_acme-challenge.files` → `d420c923-bbd7-4056-ab64-c3ca54c9b3cf.auth.acme-dns.io`.
     Thêm bản ghi CNAME đó ở PA Việt Nam (chỉ làm **1 lần**), đợi vài phút rồi bấm Enter. Từ nay win-acme tự gia hạn mỗi 60 ngày, không phải làm gì.
   - **Cách B — thủ công:** chọn **Create verification records manually** → win-acme in ra 1 bản ghi **TXT** `_acme-challenge.files` → thêm ở PA Việt Nam → Enter. Chứng chỉ hạn 90 ngày; **mỗi lần gia hạn phải thêm TXT mới** (win-acme sẽ nhắc trong Task Scheduler) — dễ quên, nên dùng cách A.
5. Lưu chứng chỉ: chọn **PFX archive** → thư mục `C:\NOIBO\certs` → đặt mật khẩu PFX (nhớ lại). Bước "installation": chọn **Start external script** với
   - Script: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
   - Tham số: `-Command "Stop-ScheduledTask NOIBO-FileServer; Start-ScheduledTask NOIBO-FileServer"`
   (để máy chủ tệp tự nạp chứng chỉ mới sau mỗi lần gia hạn).
6. Mở `.env`, sửa đúng tên file `.pfx` vừa tạo (`dir C:\NOIBO\certs`) và mật khẩu:
   ```
   HTTPS_PFX=C:\NOIBO\certs\files.thuanhunglongan.com.pfx
   HTTPS_PFX_PASSPHRASE=<mật khẩu PFX>
   ```

> Nếu công ty mua chứng chỉ wildcard `*.thuanhunglongan.com` thì bỏ qua win-acme, xuất chứng chỉ đó ra `.pfx` và điền như trên.

## 4. Chạy thử, mở tường lửa, cài chạy ngầm

```powershell
cd C:\NOIBO\fileserver
node server.js
# ✅ Máy chủ tệp NOIBO chạy HTTPS cổng 443 …   → bấm Ctrl+C để dừng, làm tiếp:

# Chỉ cho máy trong mạng LAN vào cổng 443 của máy này
New-NetFirewallRule -DisplayName "NOIBO file server" -Direction Inbound -Protocol TCP -LocalPort 443 -RemoteAddress LocalSubnet -Action Allow

# Chạy ngầm, tự bật khi khởi động máy, tự chạy lại nếu tắt
powershell -ExecutionPolicy Bypass -File .\install-task.ps1
```

- Router/modem công ty **không** được mở (NAT/port forward) cổng 443 vào 10.84.40.34 — máy chủ tệp chỉ dành cho LAN.
- Nếu `RemoteAddress LocalSubnet` không đủ (LAN có nhiều dải, VD Wi-Fi ở dải khác 10.84.40.x), thay bằng các dải cụ thể: `-RemoteAddress 10.84.0.0/16,192.168.0.0/16`.

## 5. Kiểm tra từ máy khác trong công ty

Mở trình duyệt: **https://files.thuanhunglongan.com/health** → phải thấy `{"ok":true,"name":"NOIBO file server",…}` và **ổ khoá xanh** (không cảnh báo chứng chỉ).

| Thấy gì | Nguyên nhân |
|---|---|
| Không vào được / quay mãi | DNS chưa ra 10.84.40.34 (bước 2) · tường lửa (bước 4) · máy chủ tệp chưa chạy (`Get-ScheduledTask NOIBO-FileServer`, xem `logs\server.log`) |
| Cảnh báo chứng chỉ | Chưa đặt `HTTPS_PFX` hoặc sai tên file/mật khẩu (xem `logs\server.log`) |
| Dùng điện thoại 4G mở được | Sai — router đang mở cổng ra Internet. Tắt port forward |

## 6. Khai báo cho API (máy chủ 171.237.176.73)

Thêm vào `ApiDuAnRac\.env` trên máy chủ API rồi khởi động lại (`pm2 restart all`):

```
RQ_FILE_SERVER_URL=https://files.thuanhunglongan.com
RQ_FILE_SECRET=<đúng chuỗi 64 ký tự ở bước 1>
RQ_FILE_MAX_MB=50
```

(Dùng cổng 8443 thì `RQ_FILE_SERVER_URL=https://files.thuanhunglongan.com:8443`.) API **không** cần kết nối tới 10.84.40.34 — chỉ dùng khoá để ký.

Thiếu 2 biến này thì module vẫn chạy nhưng nút đính kèm báo *"Chưa cấu hình máy chủ tệp nội bộ"*.

## 7. Lần đầu mở trên Chrome / Edge

Trang Internet (`noibo…`) gọi vào máy trong mạng nội bộ (`files…` = 10.84.40.34) nên Chrome/Edge bản mới có thể hỏi **"Cho phép truy cập các thiết bị trong mạng cục bộ?"** → bấm **Cho phép** (hỏi 1 lần/thiết bị). Bấm nhầm *Chặn* thì: bấm biểu tượng bên trái thanh địa chỉ → Cài đặt trang web → *Mạng cục bộ / Local network access* → Cho phép.

Máy tính công ty quản lý bằng Group Policy có thể cho phép sẵn bằng chính sách Chrome/Edge `LocalNetworkAccessAllowedForUrls` = `https://noibo.thuanhunglongan.com`.

## 8. Sao lưu

Tệp chỉ có ở `D:\NOIBO_FILES` — hỏng ổ là mất. Sao lưu mỗi đêm sang ổ khác/NAS (Task Scheduler → Create Basic Task → Daily 23:00 → Start a program):

```
Program: robocopy
Arguments: D:\NOIBO_FILES \\<NAS>\backup\NOIBO_FILES /E /XO /R:1 /W:1 /XD .tmp /NP /LOG+:C:\NOIBO\fileserver\logs\backup.log
```

`/XO` chỉ chép tệp mới — tệp đã lưu không bao giờ bị sửa nên sao lưu rất nhanh.

## Ghi chú kỹ thuật

- **Bảo mật**: chỉ người đã đăng nhập NOIBO mới lấy được *vé tải lên* (hạn 2 giờ) từ API; máy chủ tệp trả về chữ ký, API kiểm chữ ký trước khi gắn tệp vào đề xuất → không gắn được tệp của người khác/tệp giả. Đường dẫn xem tệp do API ký riêng cho người được xem đề xuất, **hết hạn sau 12–24 giờ**. Không nhận tệp chạy chương trình (`.exe`, `.bat`, `.js`, `.msi`…). Tệp không phải ảnh/PDF/video/âm thanh luôn tải về (không mở trong trình duyệt); SVG/HTML không được chạy script.
- **Cấu trúc lưu**: `D:\NOIBO_FILES\rq\2026\10\<uuid>.<đuôi>` + `<uuid>.<đuôi>.json` (tên gốc, người tải, thời gian) + `<uuid>.<đuôi>.thumb.jpg` (ảnh thu nhỏ do trình duyệt tạo, ~30–60 KB, để danh sách mở nhanh). Tệp tải dở nằm ở `.tmp` và tự dọn sau 1 ngày.
- **Xoá tệp**: xoá đính kèm trên web chỉ xoá liên kết trong DB, tệp vẫn còn trên đĩa (an toàn khi xoá nhầm). Muốn dọn: đối chiếu `rq_Files.storageKey` với thư mục — chưa có công cụ, nhờ IT.
- **Đổi khoá bí mật**: đổi đồng thời `FILE_SECRET` ở đây và `RQ_FILE_SECRET` ở API. Tệp cũ vẫn xem được (đường dẫn được ký lại mỗi lần mở).
- Log: `C:\NOIBO\fileserver\logs\server.log` (mỗi lần tải lên 1 dòng).
- Kiểm thử ở máy dev: `node tools/fileserver-test.js` (thư mục gốc dự án) — tự bật máy chủ tệp ở cổng 18443, thử tải lên/xuống/chữ ký/chặn tệp.
