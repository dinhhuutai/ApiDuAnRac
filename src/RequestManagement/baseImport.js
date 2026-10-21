// RequestManagement/baseImport.js — NHẬP DỮ LIỆU CŨ TỪ BASE REQUEST (request.base.vn) vào module 18
//
// Tệp Excel "xuất đề xuất" của Base: mỗi dòng 1 đề xuất. Người tạo / Người xét duyệt / Người chấp thuận / Người từ chối /
// Người theo dõi là TÊN ĐĂNG NHẬP Base (vd "ntatuyet1", "ltyphuong"); họ tên chỉ có trong cột "Ý kiến"
// ("ntdep [Nguyễn Thị Đẹp created this request]"). "Trường tuỳ chỉnh" gộp mọi trường: "Nhãn: giá trị | Nhãn: giá trị"
// (dấu | trong giá trị bị mã hoá &#124;), bảng chi tiết thành "01  TT - 1  Nội dung mua - …  SL - 2  …     02  TT - 2 …".
//
// Ở đây: đọc dòng → khớp người theo TÊN (họ tên, email, tên viết tắt kiểu Base) → khớp nhóm Base với mẫu đề xuất và từng
// nhãn với trường của mẫu theo tên → dựng đề xuất NOIBO (bản chụp trường, giá trị, người duyệt, theo dõi, bình luận, lịch sử).
// Giá trị giữ NGUYÊN như trên Base (kể cả cột "Thành tiền", "Tổng cộng", "Bằng chữ" — không tính lại).
// Không truy cập DB — imports.js nạp dữ liệu rồi gọi các hàm này; kiểm thử ở tools/rq-unit.js.
const D = require('./definition');

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const slug = (s) => fold(s).replace(/[^a-z0-9]/g, '');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad = (n) => String(n).padStart(2, '0');

/* ============================ ĐỌC TỆP ============================ */

const HEADERS = [
  ['createdAt', 'Ngày tạo'], ['creator', 'Người tạo'], ['email', 'Email người tạo'], ['group', 'Tên nhóm đề xuất'],
  ['title', 'Tên đề xuất'], ['content', 'Nội dung'], ['approvers', 'Người xét duyệt theo setup'], ['followers', 'Người theo dõi'],
  ['status', 'Trạng thái'], ['approvedBy', 'Người chấp thuận đề xuất'], ['rejectedBy', 'Người từ chối đề xuất'],
  ['updatedAt', 'Cập nhật lần cuối'], ['code', 'Mã đề xuất'], ['counter', 'Mã bộ đếm'], ['opinions', 'Ý kiến'],
  ['custom', 'Trường tuỳ chỉnh'],
];
const REQUIRED = ['code', 'creator', 'group', 'title', 'status', 'createdAt'];
const MAX_ROWS = 20000;

/** Vị trí từng cột theo dòng tiêu đề (so không dấu, bỏ khoảng trắng: "tuỳ"/"tùy" như nhau) */
function mapHeader(header) {
  const cells = (Array.isArray(header) ? header : []).map(slug);
  const idx = {};
  for (const [k, label] of HEADERS) {
    const i = cells.indexOf(slug(label));
    if (i >= 0) idx[k] = i;
  }
  const missing = REQUIRED.filter((k) => idx[k] === undefined).map((k) => HEADERS.find((h) => h[0] === k)[1]);
  return { idx, missing };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Base xuất chữ còn mã HTML (&gt; &#124; …) */
function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

/** "14/10/2026 14:49" | "3/6/2026" | "2026-10-14T14:49:00" → "2026-10-14T14:49:00" (giờ VN, như quy ước module) */
function parseDateTime(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let y, mo, d, h = 0, mi = 0, se = 0;
  if (m) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else return null;
  if (m[4] !== undefined) [h, mi, se] = [+m[4], +m[5], +(m[6] || 0)];
  const ymd = `${y}-${pad(mo)}-${pad(d)}`;
  if (!D.isValidDate(ymd) || h > 23 || mi > 59 || se > 59) return null;
  return `${ymd}T${pad(h)}:${pad(mi)}:${pad(se)}`;
}
const parseDate = (v) => (parseDateTime(v) || '').slice(0, 10) || null;

/**
 * Số kiểu Việt Nam lẫn kiểu Anh: "1.500.000" "13,986,953" "2.938" (= 2938) "1.2392" "1,5" "2.0" " 315.000 đ".
 * 1 dấu phân cách + đúng 3 chữ số sau = phân cách nghìn (cách viết VN); có cả "." và "," → dấu đứng sau là thập phân.
 * Không phải số → null.
 */
function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').replace(/\s/g, '').replace(/(vnđ|vnd|đồng|đ)$/i, '');
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  let n;
  if (dots && commas) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const [intPart, frac] = s.split(dec);
    if (frac === undefined || s.split(dec).length > 2) return null;
    const groups = intPart.split(dec === '.' ? ',' : '.');
    if (groups.slice(1).some((g) => g.length !== 3)) return null;
    n = Number(`${groups.join('')}.${frac}`);
  } else if (!dots && !commas) {
    n = Number(s);
  } else {
    const parts = s.split(dots ? '.' : ',');
    if (parts.length > 2) {
      if (parts.slice(1).some((g) => g.length !== 3)) return null;
      n = Number(parts.join(''));
    } else if (parts[1].length === 3 && parts[0] !== '0') n = Number(parts.join('')); // nghìn
    else n = Number(`${parts[0]}.${parts[1]}`);
  }
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** "ttem, ltyphuong, ntdep" → ["ttem", "ltyphuong", "ntdep"] */
const splitUsers = (s) => [...new Set(String(s ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))];

/** Cột "Ý kiến": "ntdep [Nguyễn Thị Đẹp created this request], nttuyen [Đồng ý]" → [{ user, text }] */
function parseOpinions(s) {
  const text = String(s ?? '');
  const re = /(^|,\s*)([^\s,[\]]+) \[/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ at: m.index, user: m[2], start: m.index + m[0].length });
  return marks.map((k, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    return { user: k.user, text: decodeEntities(text.slice(k.start, end).replace(/\]\s*$/, '')).trim() };
  }).filter((o) => o.text);
}
const CREATED_RE = /^(.*?)\s*(?:created this request|đã tạo đề xuất)\s*$/i;
const EDITED_RE = /(?:edited the request|đã (?:chỉnh )?sửa đề xuất)\s*$/i;

/** "Trường tuỳ chỉnh" → [{ label, value }] */
function splitCustom(s) {
  const out = [];
  for (const seg of String(s ?? '').split(' | ')) {
    const m = /^([^:|]{1,150}?):(?: ([\s\S]*))?$/.exec(seg);
    if (m && m[1].trim()) out.push({ label: decodeEntities(m[1]).trim(), value: decodeEntities(m[2] || '').trim() });
    else if (out.length) out[out.length - 1].value += ` | ${decodeEntities(seg).trim()}`;
    else if (seg.trim()) out.push({ label: 'Nội dung khác', value: decodeEntities(seg).trim() });
  }
  return out;
}

/* ---------------------------- bảng chi tiết ---------------------------- */
// "01  TT - 1  Nội dung mua - Mực  ĐVT - kg  SL - 2.938  Đơn giá -   Thành tiền - 471.260.960     02  TT - 2  …"
const ROW_SPLIT = /\s{3,}(?=\d{1,3}\s{2}\S)/;
const isTableText = (v) => /^\d{1,3}\s{2}\S[^\n]{0,80}? -(?: |$)/.test(String(v ?? ''));
const SKIP_COLUMNS = new Set(['tt', 'stt', 'sott', 'no']); // số thứ tự — NOIBO tự đánh

/** Nhãn cột theo thứ tự, đọc từ dòng đầu của bảng */
function tableLabels(text) {
  const first = String(text ?? '').trim().split(ROW_SPLIT)[0].replace(/^\d{1,3}\s{2}/, '');
  const labels = [];
  for (const piece of first.split(/\s{2,}/)) {
    const m = /^(\S[^\n]{0,60}?) -(?: |$)/.exec(piece);
    if (m && !labels.includes(m[1])) labels.push(m[1]);
  }
  return labels;
}

/** Bảng → [{ nhãn cột: chữ }] theo danh sách nhãn (đi lần lượt, ô trống được) */
function parseTableText(text, labels) {
  const rows = [];
  if (!labels?.length) return rows;
  const res = labels.map((l) => new RegExp(`(?:^|\\s{2,})${esc(l)} -(?= |$)`, 'g'));
  for (const raw of String(text ?? '').trim().split(ROW_SPLIT)) {
    const body = raw.trim().replace(/^\d{1,3}\s{2}/, '');
    if (!body) continue;
    const cells = {};
    let pos = 0, prev = null;
    labels.forEach((label, i) => {
      const re = res[i];
      re.lastIndex = pos;
      const m = re.exec(body);
      if (!m) return;
      if (prev) cells[prev.label] = body.slice(prev.start, m.index).trim();
      prev = { label, start: m.index + m[0].length };
      pos = prev.start;
    });
    if (prev) cells[prev.label] = body.slice(prev.start).trim();
    if (Object.values(cells).some(Boolean)) rows.push(cells);
  }
  return rows;
}

/* ---------------------------- trạng thái ---------------------------- */
const STATUS_RULES = [
  [/vo hieu/, 'cancelled'], // "Đã chấp thuận nhưng vô hiệu lực" — kiểm trước "chấp thuận"
  [/cho xu ly|chua xu ly|dang xu ly|qua han|pending|overdue|waiting/, 'pending'],
  [/chap thuan|da duyet|approved/, 'approved'],
  [/tu choi|rejected/, 'rejected'],
  [/tra lai|returned/, 'returned'],
  [/huy|cancel/, 'cancelled'],
];
const statusOf = (s) => STATUS_RULES.find(([re]) => re.test(fold(s)))?.[1] || null;

/**
 * Dòng Excel (mảng chữ theo tiêu đề) → đề xuất Base đã tách sẵn.
 * @returns { rows: [...], missing: [tên cột bắt buộc thiếu], errors: [{ line, code, reason }] }
 */
function readRows(header, rawRows) {
  const { idx, missing } = mapHeader(header);
  if (missing.length) return { rows: [], missing, errors: [] };
  const cell = (r, k) => (idx[k] === undefined ? '' : decodeEntities(r?.[idx[k]] ?? '').trim());
  const rows = [];
  const errors = [];
  const seen = new Set();
  (Array.isArray(rawRows) ? rawRows : []).slice(0, MAX_ROWS).forEach((r, i) => {
    const code = cell(r, 'code').slice(0, 50);
    if (!code && !cell(r, 'title')) return; // dòng trống
    const line = i + 1;
    if (!code) { errors.push({ line, code: '', reason: 'Thiếu "Mã đề xuất"' }); return; }
    if (seen.has(code)) { errors.push({ line, code, reason: 'Trùng "Mã đề xuất" trong tệp' }); return; }
    seen.add(code);
    let creatorName = '';
    let editCount = 0;
    const comments = [];
    const creator = cell(r, 'creator');
    for (const o of parseOpinions(r?.[idx.opinions])) {
      const c = CREATED_RE.exec(o.text);
      if (c) { if (o.user === creator && c[1]) creatorName = c[1].trim(); continue; }
      if (EDITED_RE.test(o.text)) { if (o.user === creator) editCount += 1; continue; }
      comments.push(o);
    }
    const custom = splitCustom(r?.[idx.custom]);
    const content = cell(r, 'content');
    if (content) custom.unshift({ label: 'Nội dung', value: content });
    rows.push({
      line,
      code,
      counter: cell(r, 'counter').slice(0, 50),
      createdAt: parseDateTime(cell(r, 'createdAt')),
      updatedAt: parseDateTime(cell(r, 'updatedAt')),
      creator,
      creatorName,
      email: cell(r, 'email'),
      group: cell(r, 'group') || '(Không có nhóm)',
      title: cell(r, 'title'),
      approvers: splitUsers(cell(r, 'approvers')),
      followers: splitUsers(cell(r, 'followers')),
      approvedBy: splitUsers(cell(r, 'approvedBy')),
      rejectedBy: splitUsers(cell(r, 'rejectedBy')),
      statusRaw: cell(r, 'status'),
      status: statusOf(cell(r, 'status')),
      editCount,
      comments,
      custom,
    });
  });
  return { rows, missing: [], errors };
}

/* ============================ KHỚP NGƯỜI THEO TÊN ============================ */

/** "Lê Thị Yến Phương" → "ltyphuong" (cách Base đặt tên đăng nhập: chữ đầu họ + đệm, cả tên; trùng thì thêm số) */
function initialsKey(fullName) {
  const w = fold(fullName).replace(/[^a-z ]/g, '').split(' ').filter(Boolean);
  if (!w.length) return '';
  return w.slice(0, -1).map((x) => x[0]).join('') + w[w.length - 1];
}
const baseKey = (u) => fold(u).replace(/\d+$/, '');
const HOW_LABEL = { previous: 'Lần nhập trước', name: 'Trùng họ tên', email: 'Trùng email', initials: 'Đoán theo tên viết tắt', username: 'Trùng tên đăng nhập' };

/** Ưu tiên: còn hoạt động > có quyền module 18 > có MSNV (tài khoản cũ "@thla" thường không có) */
const userRank = (u) => (u.isDeleted ? 0 : 8) + (u.isActive ? 4 : 0) + (u.hasModule ? 2 : 0) + (u.msnv ? 1 : 0);

/**
 * Gợi ý tài khoản NOIBO cho từng người Base.
 * @param people   [{ base, fullName, email }]
 * @param users    [{ userID, username, fullName, email, msnv, isActive, isDeleted, hasModule }]
 * @param previous { base: userId } — lần nhập trước đã chọn
 * @returns Map base → { userId|null, how, ambiguous, candidates: [userID] }
 */
function matchPeople(people, users, previous = {}) {
  const index = { name: new Map(), email: new Map(), initials: new Map(), username: new Map() };
  const add = (m, k, u) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(u); };
  const byId = new Map();
  for (const u of users) {
    byId.set(u.userID, u);
    add(index.name, fold(u.fullName), u);
    add(index.email, fold(u.email), u);
    add(index.initials, initialsKey(u.fullName), u);
    add(index.username, fold(u.username), u);
  }
  const out = new Map();
  for (const p of people) {
    const prev = previous[p.base] && byId.get(Number(previous[p.base]));
    const levels = [
      ['previous', prev ? [prev] : []],
      ['name', p.fullName ? index.name.get(fold(p.fullName)) || [] : []],
      ['email', p.email && p.email.includes('@') ? index.email.get(fold(p.email)) || [] : []],
      ['initials', index.initials.get(baseKey(p.base)) || []],
      ['username', index.username.get(fold(p.base)) || []],
    ];
    const candidates = [];
    for (const [, list] of levels) for (const u of list) if (!candidates.includes(u)) candidates.push(u);
    const hit = levels.find(([, list]) => list.length);
    if (!hit) { out.set(p.base, { userId: null, how: null, ambiguous: false, candidates: [] }); continue; }
    const list = [...hit[1]].sort((a, b) => userRank(b) - userRank(a));
    out.set(p.base, {
      userId: list[0].userID,
      how: hit[0],
      ambiguous: list.length > 1 && userRank(list[1]) === userRank(list[0]),
      candidates: candidates.sort((a, b) => userRank(b) - userRank(a)).slice(0, 6).map((u) => u.userID),
    });
  }
  return out;
}

/* ============================ NHÓM BASE → MẪU ĐỀ XUẤT ============================ */

const MAPPABLE = ['text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect', 'checkbox', 'table'];
const MONEY_RE = /tien|gia|chi phi|tong|thanh toan|tam ung|luong|kinh phi/;
const RAW_KEY = 'bxraw';
const RAW_LABEL = 'Dữ liệu Base chưa chuyển được';
const BASE_NOTE = 'Trường từ Base Request (không có trong mẫu)';

/** Thống kê 1 nhóm Base: mỗi nhãn → các giá trị; nhãn có bảng → nhãn cột thường gặp nhất + giá trị từng cột */
function groupStats(rows) {
  const map = new Map();
  for (const r of rows) {
    for (const { label, value } of r.custom) {
      if (!map.has(label)) map.set(label, { label, values: [], filled: 0 });
      const s = map.get(label);
      s.values.push(value);
      if (value) s.filled += 1;
    }
  }
  for (const s of map.values()) {
    const tbl = s.values.filter(isTableText);
    if (!tbl.length || tbl.length < s.filled * 0.5) continue;
    const freq = new Map();
    for (const t of tbl) {
      const k = tableLabels(t).join('\u0001');
      if (k) freq.set(k, (freq.get(k) || 0) + 1);
    }
    const best = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!best) continue;
    const labels = best.split('\u0001');
    const cells = Object.fromEntries(labels.map((l) => [l, []]));
    for (const t of tbl.slice(0, 500)) for (const row of parseTableText(t, labels)) for (const l of labels) if (row[l]) cells[l].push(row[l]);
    s.table = { labels, cells };
  }
  return [...map.values()];
}

function guessColumnType(label, values) {
  const vals = (values || []).filter(Boolean);
  if (!vals.length) return 'text';
  if (vals.every((v) => parseNumber(v) !== null)) return MONEY_RE.test(fold(label)) ? 'currency' : 'number';
  if (vals.every((v) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) && parseDate(v))) return 'date';
  return 'text';
}

/** Đoán loại trường cho 1 nhãn Base không có trong mẫu (hoặc khi tạo mẫu mới) */
function guessField(stat, key) {
  const f = { key, type: 'text', label: stat.label.slice(0, 300), required: false, width: 'full' };
  if (stat.table) {
    let n = 0;
    f.type = 'table';
    f.maxRows = 200;
    f.columns = stat.table.labels.filter((l) => !SKIP_COLUMNS.has(slug(l))).map((l) => {
      const type = guessColumnType(l, stat.table.cells[l]);
      const c = { key: `c${++n}`, label: l.slice(0, 150), type };
      if (type === 'currency') c.sum = true;
      return c;
    });
    if (!f.columns.length) f.columns = [{ key: 'c1', label: 'Nội dung', type: 'text' }];
    return f;
  }
  const vals = stat.values.filter(Boolean);
  const maxLen = Math.max(0, ...vals.map((v) => v.length));
  if (vals.length && vals.every((v) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) && parseDate(v))) f.type = 'date';
  else if (vals.length && vals.every((v) => parseNumber(v) !== null)) f.type = MONEY_RE.test(fold(stat.label)) ? 'currency' : 'number';
  else if (maxLen > 120 || vals.some((v) => v.includes('\n'))) f.type = 'textarea';
  else {
    const distinct = [...new Set(vals)];
    if (vals.length >= 10 && distinct.length <= 8 && maxLen <= 60) {
      f.type = 'select';
      f.options = distinct.map((label, i) => ({ id: `o${i + 1}`, label }));
    }
  }
  if (f.type !== 'textarea') f.width = 'half';
  return f;
}

/** Nhãn Base ↔ trường của mẫu: trùng tên (không dấu, bỏ dấu câu); không có thì tên này chứa tên kia (≥ 6 ký tự) */
function autoMatch(label, fields, taken) {
  const s = slug(label);
  const free = fields.filter((f) => MAPPABLE.includes(f.type) && !taken.has(f.key));
  return free.find((f) => slug(f.label) === s)
    || free.find((f) => { const t = slug(f.label); return Math.min(t.length, s.length) >= 6 && (t.includes(s) || s.includes(t)); })
    || null;
}

/**
 * Dựng BẢN CHỤP TRƯỜNG cho mọi đề xuất của 1 nhóm Base + cách chuyển từng nhãn.
 * Trường của mẫu giữ nguyên; nhãn Base không có trong mẫu → thêm trường (chỉ trong bản chụp, mẫu không đổi);
 * lựa chọn / cột bảng chưa có → thêm vào bản chụp.
 * @param stats      groupStats(...)
 * @param typeFields trường của mẫu đích ([] = tạo mẫu mới từ dữ liệu)
 * @param fieldMap   { nhãn Base: fieldKey } admin chọn — '' = thêm trường riêng; không có = tự khớp theo tên
 * @returns { fields, plan: [{ label, key, extra, auto, table?: { labels, colMap } }] }
 */
function buildSchema(stats, typeFields, fieldMap = {}) {
  const fields = JSON.parse(JSON.stringify(typeFields || []));
  const used = new Set(fields.map((f) => f.key));
  const taken = new Set();
  const plan = [];
  let n = 0;
  const nextKey = () => { let k; do { k = `bx${++n}`; } while (used.has(k)); used.add(k); return k; };
  for (const s of stats) {
    const want = fieldMap[s.label];
    let target = null, auto = false;
    if (want) target = fields.find((f) => f.key === want && MAPPABLE.includes(f.type) && !taken.has(f.key)) || null;
    else if (want === undefined) { target = autoMatch(s.label, fields, taken); auto = !!target; }
    if (target?.type === 'table' && !s.table) target = null; // chữ thường không đổ vào bảng được
    let extra = false;
    if (!target) {
      target = guessField(s, nextKey());
      target.description = BASE_NOTE;
      fields.push(target);
      extra = true;
      auto = false;
    }
    taken.add(target.key);
    const p = { label: s.label, key: target.key, extra, auto };
    if (target.type === 'table' && s.table) {
      const colMap = {};
      const takenCols = new Set();
      const colUsed = new Set(target.columns.map((c) => c.key));
      let cn = 0;
      for (const l of s.table.labels) {
        if (SKIP_COLUMNS.has(slug(l))) { colMap[l] = null; continue; }
        let c = target.columns.find((x) => !takenCols.has(x.key) && slug(x.label) === slug(l));
        if (!c) {
          let k;
          do { k = `cx${++cn}`; } while (colUsed.has(k));
          colUsed.add(k);
          c = { key: k, label: l.slice(0, 150), type: guessColumnType(l, s.table.cells[l]) };
          target.columns.push(c);
        }
        takenCols.add(c.key);
        colMap[l] = c.key;
      }
      p.table = { labels: s.table.labels, colMap };
    }
    if (target.type === 'select' || target.type === 'multiselect') {
      target.options = target.options || [];
      const ids = new Set(target.options.map((o) => o.id));
      let on = 0;
      const vals = target.type === 'multiselect' ? s.values.flatMap((v) => v.split(/,\s*/)) : s.values;
      for (const v of vals.map((x) => x.trim()).filter(Boolean)) {
        if (target.options.some((o) => fold(o.label) === fold(v))) continue;
        let id;
        do { id = `ox${++on}`; } while (ids.has(id));
        ids.add(id);
        target.options.push({ id, label: v.slice(0, 200) });
      }
    }
    plan.push(p);
  }
  return { fields, plan };
}

/** 1 ô của bảng theo loại cột. Không chuyển được → giữ nguyên chữ (bảng vẫn hiện đúng chữ đó) */
function cellValue(col, v) {
  if (!v) return undefined;
  if (col.type === 'number' || col.type === 'currency' || col.type === 'formula') {
    const n = parseNumber(v);
    if (n === null) return v;
    return col.type === 'currency' ? Math.round(n) : n;
  }
  if (col.type === 'date') return parseDate(v) || v;
  return v;
}

/**
 * Giá trị Base → giá trị trường NOIBO. Không chuyển được → leftovers (đổ vào trường "Dữ liệu Base chưa chuyển được").
 * Trường tự tính (tổng, bằng chữ, "Thành tiền") lấy NGUYÊN số Base, không tính lại.
 */
function convertValues(row, schema) {
  const byKey = new Map(schema.fields.map((f) => [f.key, f]));
  const planByLabel = new Map(schema.plan.map((p) => [p.label, p]));
  const values = {};
  const leftovers = [];
  const keep = (label, v) => leftovers.push(`${label}: ${v}`);
  for (const { label, value } of row.custom) {
    if (!value) continue;
    const p = planByLabel.get(label);
    const f = p && byKey.get(p.key);
    if (!f) { keep(label, value); continue; }
    switch (f.type) {
      case 'text':
      case 'textarea':
        values[f.key] = values[f.key] ? `${values[f.key]}\n${value}` : value;
        break;
      case 'number':
      case 'currency': {
        const n = parseNumber(value);
        if (n === null || (f.type === 'currency' && n < 0)) keep(label, value);
        else values[f.key] = f.type === 'currency' ? Math.round(n) : n;
        break;
      }
      case 'date': {
        const d = parseDate(value);
        if (d) values[f.key] = d; else keep(label, value);
        break;
      }
      case 'select': {
        const o = f.options.find((x) => fold(x.label) === fold(value));
        if (o) values[f.key] = o.id; else keep(label, value);
        break;
      }
      case 'multiselect': {
        const ids = value.split(/,\s*/).map((v) => f.options.find((x) => fold(x.label) === fold(v))?.id).filter(Boolean);
        if (ids.length) values[f.key] = [...new Set(ids)]; else keep(label, value);
        break;
      }
      case 'checkbox': {
        const t = fold(value);
        if (/^(co|yes|true|x|1|da|dong y)$/.test(t)) values[f.key] = true;
        else if (/^(khong|no|false|0)$/.test(t)) values[f.key] = false;
        else keep(label, value);
        break;
      }
      case 'table': {
        const tp = p.table || { labels: [], colMap: {} };
        let parsed = parseTableText(value, tp.labels);
        if (!parsed.length) parsed = parseTableText(value, tableLabels(value)); // bảng của dòng này khác nhãn thường gặp
        if (!parsed.length) { keep(label, value); break; }
        const colBySlug = new Map(f.columns.map((c) => [slug(c.label), c]));
        const rows = parsed.map((cells) => {
          const r = {};
          for (const [l, v] of Object.entries(cells)) {
            if (!v || SKIP_COLUMNS.has(slug(l))) continue;
            const c = f.columns.find((x) => x.key === tp.colMap[l]) || colBySlug.get(slug(l));
            if (!c) { keep(`${label} – ${l}`, v); continue; }
            const cv = cellValue(c, v);
            if (cv !== undefined) r[c.key] = cv;
          }
          return r;
        }).filter((r) => Object.keys(r).length);
        if (rows.length) values[f.key] = rows;
        break;
      }
      default:
        keep(label, value);
    }
  }
  return { values, leftovers };
}

/* ============================ DỰNG ĐỀ XUẤT ============================ */

/** Tên bước cho từng người duyệt: lấy theo quy trình của mẫu (người nằm ở bước nào), không có → "Người duyệt n" */
function stepNamer(flow) {
  let ptr = 0;
  let n = 0;
  return (userId) => {
    n += 1;
    for (let i = ptr; i < (flow || []).length; i++) {
      if ((flow[i].userIds || []).includes(userId)) { ptr = i + 1; return flow[i].name; }
    }
    return `Người duyệt ${n}`;
  };
}

const FINAL = ['approved', 'rejected', 'cancelled'];
const skip = (reason) => ({ ok: false, reason });

/**
 * 1 đề xuất Base → dữ liệu để ghi vào rq_* (chưa gồm ảnh chụp người gửi — imports.js thêm từ hồ sơ).
 * @param row  1 phần tử readRows().rows
 * @param ctx  { groups: { tên nhóm Base: { skip, typeId, typeName, groupId, flow, fields, plan } },
 *              people: { base: userId }, pendingMode: 'continue'|'skip', importerId }
 */
function buildRequest(row, ctx) {
  const g = ctx.groups[row.group];
  if (!g || g.skip) return skip(`Nhóm "${row.group}" chọn không nhập`);
  if (!row.status) return skip(`Trạng thái "${row.statusRaw}" chưa hỗ trợ`);
  if (ctx.pendingMode === 'skip' && (row.status === 'pending' || row.status === 'returned')) return skip('Chưa xong trên Base — chọn không nhập đề xuất chưa xong');
  if (!row.createdAt) return skip('"Ngày tạo" không đọc được');
  const requesterId = ctx.people[row.creator] || null;
  if (!requesterId) return skip(`Người tạo "${row.creator}" chưa khớp tài khoản NOIBO`);
  const updatedAt = row.updatedAt && row.updatedAt >= row.createdAt ? row.updatedAt : row.createdAt;
  const warnings = [];

  const { values, leftovers } = convertValues(row, g);
  if (leftovers.length) {
    if (g.fields.some((f) => f.key === RAW_KEY)) values[RAW_KEY] = leftovers.join('\n');
    warnings.push(`Không chuyển được: ${leftovers.join('; ').slice(0, 300)}`);
  }

  // người duyệt: theo thứ tự "Người xét duyệt theo setup" — bỏ người chưa khớp, bỏ chính người gửi, mỗi người 1 bước
  const approved = new Set(row.approvedBy);
  const rejected = new Set(row.rejectedBy);
  const nameOf = stepNamer(g.flow);
  const steps = [];
  const unmatched = [];
  for (const b of row.approvers) {
    const id = ctx.people[b];
    if (!id) { unmatched.push(b); continue; }
    if (id === requesterId || steps.some((s) => s.userId === id)) continue;
    const st = approved.has(b) ? 'approved' : rejected.has(b) ? 'rejected' : 'waiting';
    steps.push({ stepNo: steps.length + 1, stepName: nameOf(id), stepMode: 'all', userId: id, status: st, note: null, actedAt: st === 'waiting' ? null : updatedAt, base: b });
  }
  if (unmatched.length) warnings.push(`Bỏ người duyệt chưa khớp: ${unmatched.join(', ')}`);

  let status = row.status;
  let currentStep = 1;
  if (status === 'pending') {
    const next = steps.find((s) => s.status === 'waiting');
    if (!next) {
      const waitingBase = row.approvers.find((b) => !approved.has(b) && !rejected.has(b) && ctx.people[b] !== requesterId);
      return skip(waitingBase && !ctx.people[waitingBase]
        ? `Đang chờ "${waitingBase}" duyệt nhưng người này chưa khớp tài khoản NOIBO`
        : 'Base ghi đang chờ duyệt nhưng không còn ai chờ duyệt');
    }
    next.status = 'pending';
    currentStep = next.stepNo;
    // Base duyệt lần lượt — người đứng sau người đang chờ mà đã duyệt (hiếm) vẫn giữ "đã duyệt"
  } else {
    for (const s of steps) if (s.status === 'waiting') s.status = 'skipped';
    const acted = steps.filter((s) => s.status === 'approved' || s.status === 'rejected');
    currentStep = status === 'returned' ? 1 : Math.max(1, acted.length ? acted[acted.length - 1].stepNo : steps.length);
  }

  // lịch sử: tạo → (sửa) → duyệt / từ chối / trả lại / huỷ → "nhập từ Base" (lúc nhập)
  const activities = [{ userId: requesterId, action: 'create', stepNo: null, note: null, at: row.createdAt }];
  if (row.editCount) activities.push({ userId: requesterId, action: 'edit', stepNo: null, note: `Đã sửa ${row.editCount} lần trên Base`, at: row.createdAt });
  for (const s of steps) {
    if (s.status === 'approved') activities.push({ userId: s.userId, action: 'approve', stepNo: s.stepNo, note: null, at: updatedAt });
    if (s.status === 'rejected') activities.push({ userId: s.userId, action: 'reject', stepNo: s.stepNo, note: null, at: updatedAt });
  }
  if (status === 'rejected' && !steps.some((s) => s.status === 'rejected')) {
    activities.push({ userId: null, action: 'reject', stepNo: null, note: `Từ chối trên Base: ${row.rejectedBy.join(', ') || '(không rõ)'}`, at: updatedAt });
  }
  const commenters = row.comments.map((c) => ctx.people[c.user]).filter((id) => id && id !== requesterId);
  if (status === 'returned') {
    activities.push({ userId: commenters[commenters.length - 1] || null, action: 'return', stepNo: null, note: 'Trả lại trên Base Request', at: updatedAt });
  }
  if (status === 'cancelled') activities.push({ userId: null, action: 'cancel', stepNo: null, note: `Trên Base: ${row.statusRaw}`, at: updatedAt });
  activities.push({
    userId: ctx.importerId || null, action: 'import', stepNo: null, at: null,
    note: `Nhập từ Base Request · mã đề xuất ${row.code}${row.counter ? ` · mã bộ đếm ${row.counter}` : ''}`,
  });

  // ý kiến trên Base → bình luận (người chưa khớp: ghi dưới tên người nhập, kèm tên Base)
  const comments = row.comments.map((c) => {
    const uid = ctx.people[c.user];
    return { userId: uid || ctx.importerId, body: (uid ? c.text : `[${c.user} trên Base] ${c.text}`).slice(0, 4000), at: updatedAt };
  }).filter((c) => c.userId);

  const approverIds = new Set(steps.map((s) => s.userId));
  const followers = [...new Set(row.followers.map((b) => ctx.people[b]).filter(Boolean))]
    .filter((id) => id !== requesterId && !approverIds.has(id));

  const flow = steps.map((s) => ({ key: `s${s.stepNo}`, name: s.stepName, approverType: 'users', userIds: [s.userId], mode: 'all' }));
  return {
    ok: true,
    warnings,
    request: {
      externalId: row.code,
      externalCode: row.counter || null,
      typeId: g.typeId,
      typeName: g.typeName,
      groupId: g.groupId ?? null,
      title: (row.title || `${g.typeName} (Base ${row.code})`).slice(0, 300),
      requesterId,
      fieldValues: values,
      flow,
      status,
      currentStep,
      stepCount: steps.length,
      createdAt: row.createdAt,
      updatedAt,
      finishedAt: FINAL.includes(status) ? updatedAt : null,
      editCount: row.editCount,
      commentCount: comments.length,
      approvers: steps.map(({ base, ...s }) => s),
      followers,
      comments,
      activities,
    },
  };
}

/** Viết hoa toàn bộ → viết hoa chữ đầu ("ĐỀ XUẤT TRỰC TIẾP" → "Đề xuất trực tiếp") */
function sentenceCase(s) {
  const t = String(s || '').trim();
  if (t !== t.toUpperCase()) return t;
  const low = t.toLowerCase();
  return low.charAt(0).toUpperCase() + low.slice(1);
}

/** Mẫu đề xuất mới dựng từ dữ liệu Base (đang ẩn — admin xem lại rồi bật). Quy trình = chuỗi người duyệt hay gặp nhất */
function newTypeBody(groupName, schema, approverIds, groupId) {
  const flow = approverIds.length
    ? approverIds.map((id, i) => ({ name: `Người duyệt ${i + 1}`, approverType: 'users', userIds: [id], mode: 'all' }))
    : [{ name: 'Người duyệt', approverType: 'requester_pick', mode: 'all' }];
  return {
    name: sentenceCase(groupName).slice(0, 200) || 'Đề xuất từ Base',
    groupId: groupId || null,
    description: 'Tạo khi nhập dữ liệu cũ từ Base Request',
    icon: 'FileText',
    color: '#475569',
    fields: schema.fields.map(({ description, ...f }) => (f.key === RAW_KEY ? { ...f, description } : f)),
    flow,
    audience: { type: 'all' },
    isActive: false,
  };
}

/**
 * Phân tích cả tệp (xem trước) + dựng cấu hình nhập.
 * @param input    { header, rows }
 * @param env      { users, types: [{ typeId, name, groupId, fields, flow, isActive }], existing: Set(mã đã nhập), previousPeople, importerId }
 * @param settings { people: { base: userId | 0 }, groups: { tên: { target: typeId|'new'|'skip', fieldMap, newGroupId } }, pendingMode }
 */
function analyze(input, env, settings = {}) {
  const read = readRows(input?.header, input?.rows);
  if (read.missing.length) return { missing: read.missing, total: 0 };
  const { rows } = read;
  const existing = env.existing || new Set();

  // ---- người ----
  const info = new Map();
  const person = (base) => {
    if (!info.has(base)) info.set(base, { base, fullName: '', email: '', roles: { requester: 0, approver: 0, follower: 0, commenter: 0 } });
    return info.get(base);
  };
  for (const r of rows) {
    const p = person(r.creator);
    p.roles.requester += 1;
    if (r.creatorName) p.fullName = r.creatorName;
    if (r.email) p.email = r.email;
    for (const b of new Set([...r.approvers, ...r.approvedBy, ...r.rejectedBy])) person(b).roles.approver += 1;
    for (const b of r.followers) person(b).roles.follower += 1;
    for (const c of r.comments) person(c.user).roles.commenter += 1;
  }
  const matched = matchPeople([...info.values()], env.users || [], env.previousPeople || {});
  const chosen = settings.people || {};
  const userById = new Map((env.users || []).map((u) => [u.userID, u]));
  const peopleMap = {};
  const people = [...info.values()].map((p) => {
    const m = matched.get(p.base);
    const pick = Object.prototype.hasOwnProperty.call(chosen, p.base) ? (Number(chosen[p.base]) || null) : m.userId;
    const userId = pick && userById.has(pick) ? pick : null;
    if (userId) peopleMap[p.base] = userId;
    return { ...p, userId, suggestion: m, how: userId && userId === m.userId ? m.how : userId ? 'manual' : null };
  });
  // tên các tài khoản được gợi ý / đang chọn — kể cả tài khoản đã khoá (danh bạ trên trình duyệt chỉ có người đang hoạt động)
  const refIds = new Set();
  for (const p of people) {
    if (p.userId) refIds.add(p.userId);
    p.suggestion.candidates.forEach((id) => refIds.add(id));
  }
  const userInfo = Object.fromEntries([...refIds].map((id) => {
    const u = userById.get(id);
    return [id, { name: u.fullName, username: u.username, msnv: u.msnv, active: !!u.isActive && !u.isDeleted, hasModule: !!u.hasModule }];
  }));

  // ---- nhóm → mẫu ----
  const typesById = new Map((env.types || []).map((t) => [t.typeId, t]));
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r);
  }
  const groupCfg = {};
  const groups = [];
  for (const [name, list] of byGroup) {
    const set = settings.groups?.[name] || {};
    const suggested = (env.types || []).filter((t) => slug(t.name) === slug(name)).sort((a, b) => Number(b.isActive) - Number(a.isActive))[0];
    let target = set.target === 'new' || set.target === 'skip' ? set.target : typesById.has(Number(set.target)) ? Number(set.target) : null;
    if (target === null) target = suggested ? suggested.typeId : 'new';
    const stats = groupStats(list);
    const type = typeof target === 'number' ? typesById.get(target) : null;
    const schema = buildSchema(stats, type ? type.fields : [], set.fieldMap || {});
    // tần suất chuỗi người duyệt (để dựng quy trình khi tạo mẫu mới)
    const seqFreq = new Map();
    for (const r of list) {
      const ids = r.approvers.map((b) => peopleMap[b]).filter(Boolean);
      const k = [...new Set(ids)].join(',');
      if (k) seqFreq.set(k, (seqFreq.get(k) || 0) + 1);
    }
    const topSeq = [...seqFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const cfg = {
      skip: target === 'skip',
      isNew: target === 'new',
      typeId: type ? type.typeId : null,
      typeName: type ? type.name : sentenceCase(name),
      groupId: type ? type.groupId : Number(set.newGroupId) || null,
      flow: type ? type.flow : [],
      fields: schema.fields,
      plan: schema.plan,
      approverSeq: topSeq ? topSeq.split(',').map(Number) : [],
    };
    groupCfg[name] = cfg;
    groups.push({
      name, count: list.length, target, suggestedTypeId: suggested?.typeId || null,
      newGroupId: cfg.groupId,
      labels: stats.map((s) => {
        const p = schema.plan.find((x) => x.label === s.label);
        const f = schema.fields.find((x) => x.key === p.key);
        return {
          label: s.label, filled: s.filled, sample: s.values.find(Boolean)?.slice(0, 160) || '',
          key: p.extra ? '' : p.key, auto: p.auto, extra: p.extra, fieldType: f.type,
          columns: p.table ? p.table.labels.map((l) => ({ label: l, key: p.table.colMap[l], name: f.columns.find((c) => c.key === p.table.colMap[l])?.label || null })) : null,
        };
      }),
    });
  }

  // ---- từng đề xuất: dựng thử để đếm nhập / bỏ qua; nhóm có dữ liệu không chuyển được → thêm trường "chưa chuyển được" ----
  const ctx = { groups: groupCfg, people: peopleMap, pendingMode: settings.pendingMode === 'skip' ? 'skip' : 'continue', importerId: env.importerId };
  const results = [];
  for (const r of rows) {
    const g = groupCfg[r.group];
    if (existing.has(r.code)) { results.push({ r, already: true }); continue; }
    let b = buildRequest(r, ctx);
    if (b.ok && b.warnings.some((w) => w.startsWith('Không chuyển được')) && !g.fields.some((f) => f.key === RAW_KEY)) {
      g.fields.push({ key: RAW_KEY, type: 'textarea', label: RAW_LABEL, required: false, width: 'full', description: 'Giá trị trên Base không đọc được theo loại trường của mẫu — giữ nguyên chữ' });
      b = buildRequest(r, ctx);
    }
    results.push({ r, b });
  }
  const samples = {};
  for (const x of results) {
    if (!x.b?.ok || samples[x.r.group]) continue;
    samples[x.r.group] = { code: x.r.code, title: x.b.request.title, fields: groupCfg[x.r.group].fields, values: x.b.request.fieldValues, approvers: x.b.request.approvers, comments: x.b.request.comments, followers: x.b.request.followers, requesterId: x.b.request.requesterId, status: x.b.request.status };
  }
  const byStatus = {};
  for (const r of rows) byStatus[r.status || 'unknown'] = (byStatus[r.status || 'unknown'] || 0) + 1;
  const dates = rows.map((r) => r.createdAt).filter(Boolean).sort();
  return {
    missing: [],
    total: rows.length,
    errors: read.errors,
    byStatus,
    dateRange: dates.length ? { from: dates[0].slice(0, 10), to: dates[dates.length - 1].slice(0, 10) } : null,
    willCreate: results.filter((x) => x.b?.ok).length,
    already: results.filter((x) => x.already).length,
    skipped: results.filter((x) => x.b && !x.b.ok).length,
    warned: results.filter((x) => x.b?.ok && x.b.warnings.length).length,
    people: people.sort((a, b) => Number(!!a.userId) - Number(!!b.userId) || (b.roles.requester + b.roles.approver) - (a.roles.requester + a.roles.approver)),
    userInfo,
    groups,
    samples,
    rows: results.map(({ r, b, already }) => ({
      code: r.code, title: r.title, group: r.group, creator: r.creator, status: r.status, createdAt: r.createdAt,
      state: already ? 'already' : b.ok ? 'ok' : 'skip', reason: already ? 'Đã nhập trước đó' : b.ok ? null : b.reason,
      warnings: b?.ok ? b.warnings : [],
    })),
    // để imports.js tạo lần nhập (không gửi về trình duyệt)
    config: { groups: groupCfg, people: peopleMap, pendingMode: ctx.pendingMode },
  };
}

module.exports = {
  HOW_LABEL,
  RAW_KEY,
  fold,
  slug,
  mapHeader,
  decodeEntities,
  parseDateTime,
  parseDate,
  parseNumber,
  splitUsers,
  parseOpinions,
  splitCustom,
  isTableText,
  tableLabels,
  parseTableText,
  statusOf,
  readRows,
  initialsKey,
  matchPeople,
  groupStats,
  guessField,
  buildSchema,
  convertValues,
  buildRequest,
  newTypeBody,
  analyze,
};
