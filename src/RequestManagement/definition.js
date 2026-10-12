// RequestManagement/definition.js — Module 18 "Quản lý đề xuất"
// Loại trường của mẫu đề xuất, chuẩn hoá định nghĩa mẫu (trường + quy trình duyệt + đối tượng),
// kiểm tra/chuẩn hoá giá trị người gửi nhập, và giải quy trình duyệt ra danh sách người duyệt.
// Không truy cập DB — để kiểm thử độc lập (tools/rq-unit.js).
//
// Frontend có bản mô tả loại trường tương ứng ở pagesRequest/shared/fieldTypes.js — sửa một bên phải sửa cả hai
// (kể cả phần TỰ TÍNH: cột "= A × B" của bảng, trường "tổng của cột", trường "số tiền bằng chữ").

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const FIELD_TYPES = ['section', 'text', 'textarea', 'number', 'currency', 'date', 'daterange', 'select', 'multiselect', 'checkbox', 'user', 'files', 'table'];
// cột của trường bảng: formula = tích 2 cột số (vd Thành tiền = SL × Đơn giá), tự tính
const COLUMN_TYPES = ['text', 'number', 'currency', 'date', 'formula'];
const APPROVER_TYPES = ['users', 'dept_head', 'team_head', 'requester_pick'];
const STEP_MODES = ['all', 'any'];
const MAX_FIELDS = 60;
const MAX_STEPS = 10;
const MAX_OPTIONS = 100;
const MAX_COLUMNS = 12;
const MAX_ROWS = 200;
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const bool = (v, dflt = false) => (v === undefined || v === null ? dflt : v === true || v === 'true' || v === 1 || v === '1');
const ids = (arr, max = 500) =>
  [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, max);

function isValidDate(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2200;
}

function newKey(prefix, used) {
  let k;
  do { k = `${prefix}${Math.random().toString(36).slice(2, 9)}`; } while (used.has(k));
  used.add(k);
  return k;
}

/* ============================ TỰ TÍNH (có bản sao ở frontend fieldTypes.js) ============================ */

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
/** Đọc 1 nhóm 3 chữ số. full = có nhóm lớn hơn đứng trước → đọc đủ "không trăm lẻ …" */
function readTriple(n, full) {
  const tr = Math.floor(n / 100), ch = Math.floor((n % 100) / 10), dv = n % 10;
  const out = [];
  if (tr > 0 || full) out.push(DIGITS[tr], 'trăm');
  if (ch === 0) { if (dv > 0 && (tr > 0 || full)) out.push('lẻ'); }
  else if (ch === 1) out.push('mười');
  else out.push(DIGITS[ch], 'mươi');
  if (dv > 0) {
    if (dv === 1 && ch > 1) out.push('mốt');
    else if (dv === 5 && ch > 0) out.push('lăm');
    else out.push(DIGITS[dv]);
  }
  return out.join(' ');
}
/** 2329544 → "Hai triệu ba trăm hai mươi chín nghìn năm trăm bốn mươi bốn đồng" */
function moneyToWords(value) {
  let n = Math.round(Math.abs(Number(value)));
  if (!Number.isFinite(n) || n > 1e15) return '';
  const units = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];
  const groups = [];
  do { groups.push(n % 1000); n = Math.floor(n / 1000); } while (n > 0);
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0 && groups.length > 1) continue;
    parts.push(`${readTriple(groups[i], i < groups.length - 1) || 'không'}${units[i] ? ` ${units[i]}` : ''}`);
  }
  const s = `${Number(value) < 0 ? 'âm ' : ''}${parts.join(' ')} đồng`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round4 = (n) => Math.round(n * 10000) / 10000;
const isNumericCol = (c) => !!c && (c.type === 'number' || c.type === 'currency' || c.type === 'formula');
/** Cột formula là tiền khi 1 trong 2 cột nhân là tiền */
const isMoneyCol = (cols, c) => c.type === 'currency' || (c.type === 'formula' && (c.of || []).some((k) => cols.find((x) => x.key === k)?.type === 'currency'));

/** Tính các cột "= A × B" của 1 dòng (sửa trực tiếp row) */
function computeRow(columns, row) {
  for (const c of columns) {
    if (c.type !== 'formula') continue;
    const a = row[c.of?.[0]], b = row[c.of?.[1]];
    if (isNum(a) && isNum(b)) row[c.key] = isMoneyCol(columns, c) ? Math.round(a * b) : round4(a * b);
    else delete row[c.key];
  }
  return row;
}
/** Tổng 1 cột số của bảng (null nếu không dòng nào có số) */
function columnSum(columns, rows, colKey) {
  const c = columns.find((x) => x.key === colKey);
  if (!c) return null;
  const nums = (rows || []).map((r) => r?.[colKey]).filter(isNum);
  if (!nums.length) return null;
  const s = nums.reduce((a, b) => a + b, 0);
  return isMoneyCol(columns, c) ? Math.round(s) : round4(s);
}

/* ============================ ĐỊNH NGHĨA MẪU ============================ */

function normalizeColumns(f, label) {
  const used = new Set();
  const cols = (Array.isArray(f.columns) ? f.columns : []).slice(0, MAX_COLUMNS).map((c) => {
    const clabel = str(typeof c === 'string' ? c : c?.label, 150);
    if (!clabel) return null;
    let key = str(c?.key, 40);
    if (!KEY_RE.test(key) || used.has(key)) key = newKey('c', used);
    else used.add(key);
    const type = COLUMN_TYPES.includes(c?.type) ? c.type : 'text';
    const col = { key, label: clabel, type };
    if (isNumericCol(col) && bool(c.sum)) col.sum = true; // hiện dòng "Tổng cộng" dưới bảng
    if (type === 'formula') col.of = [str(c?.of?.[0], 40), str(c?.of?.[1], 40)];
    return col;
  }).filter(Boolean);
  if (!cols.length) throw new ValidationError(`Bảng "${label}" chưa có cột`);
  const plain = new Set(cols.filter((c) => c.type === 'number' || c.type === 'currency').map((c) => c.key));
  for (const c of cols) {
    if (c.type === 'formula' && !(plain.has(c.of[0]) && plain.has(c.of[1]))) {
      throw new ValidationError(`Bảng "${label}", cột "${c.label}": chọn 2 cột số để nhân`);
    }
  }
  return cols;
}

function normalizeField(f, used) {
  const type = FIELD_TYPES.includes(f?.type) ? f.type : null;
  if (!type) throw new ValidationError(`Loại trường không hợp lệ: ${f?.type}`);
  let key = str(f.key, 40);
  if (!KEY_RE.test(key) || used.has(key)) key = newKey('f', used);
  else used.add(key);
  const label = str(f.label, 300);
  if (!label) throw new ValidationError('Có trường chưa nhập tên');

  const out = { key, type, label };
  const description = str(f.description, 1000);
  if (description) out.description = description;
  if (type !== 'section') out.required = bool(f.required);
  out.width = f.width === 'half' && !['textarea', 'section', 'files', 'multiselect', 'table'].includes(type) ? 'half' : 'full';
  const placeholder = str(f.placeholder, 200);
  if (placeholder && ['text', 'textarea', 'number', 'currency'].includes(type)) out.placeholder = placeholder;

  if (type === 'select' || type === 'multiselect') {
    const optUsed = new Set();
    const options = (Array.isArray(f.options) ? f.options : [])
      .map((o) => {
        const label = str(typeof o === 'string' ? o : o?.label, 200);
        if (!label) return null;
        let id = str(o?.id, 40);
        if (!KEY_RE.test(id) || optUsed.has(id)) id = newKey('o', optUsed);
        else optUsed.add(id);
        return { id, label };
      })
      .filter(Boolean)
      .slice(0, MAX_OPTIONS);
    if (!options.length) throw new ValidationError(`Trường "${label}" chưa có lựa chọn`);
    out.options = options;
  }
  if (type === 'number') {
    const unit = str(f.unit, 30);
    if (unit) out.unit = unit;
    for (const k of ['min', 'max']) {
      if (f[k] !== undefined && f[k] !== null && f[k] !== '' && Number.isFinite(Number(f[k]))) out[k] = Number(f[k]);
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) throw new ValidationError(`Trường "${label}": giá trị nhỏ nhất lớn hơn lớn nhất`);
  }
  if (type === 'user') out.multiple = bool(f.multiple);
  if (type === 'files') out.maxFiles = Math.min(20, Math.max(1, Number(f.maxFiles) || 10));
  if (type === 'table') {
    out.columns = normalizeColumns(f, label);
    out.maxRows = Math.min(MAX_ROWS, Math.max(1, Number(f.maxRows) || 50));
  }
  // TỰ TÍNH — kiểm tra tham chiếu ở checkComputed() sau khi có đủ danh sách trường
  if ((type === 'number' || type === 'currency') && f.sumOf && typeof f.sumOf === 'object') {
    const table = str(f.sumOf.table, 40), column = str(f.sumOf.column, 40);
    if (table && column) out.sumOf = { table, column }; // = tổng 1 cột của trường bảng
  }
  if (type === 'text' && str(f.wordsOf, 40)) out.wordsOf = str(f.wordsOf, 40); // = số tiền (trường khác) đọc bằng chữ
  return out;
}

/** Trường tự tính phải trỏ tới trường/cột còn tồn tại và đúng loại */
function checkComputed(fields) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const f of fields) {
    if (f.sumOf) {
      const t = byKey.get(f.sumOf.table);
      const c = t?.type === 'table' ? t.columns.find((x) => x.key === f.sumOf.column) : null;
      if (!isNumericCol(c)) throw new ValidationError(`Trường "${f.label}": chọn lại cột của bảng để tính tổng`);
    }
    if (f.wordsOf) {
      const s = byKey.get(f.wordsOf);
      if (!s || (s.type !== 'number' && s.type !== 'currency')) throw new ValidationError(`Trường "${f.label}": chọn lại trường số tiền để đọc bằng chữ`);
    }
  }
}

function normalizeFlow(flow) {
  const steps = Array.isArray(flow) ? flow : [];
  if (!steps.length) throw new ValidationError('Quy trình duyệt cần ít nhất 1 bước');
  if (steps.length > MAX_STEPS) throw new ValidationError(`Tối đa ${MAX_STEPS} bước duyệt`);
  const used = new Set();
  return steps.map((s, i) => {
    const approverType = APPROVER_TYPES.includes(s?.approverType) ? s.approverType : null;
    if (!approverType) throw new ValidationError(`Bước ${i + 1}: chưa chọn người duyệt`);
    let key = str(s.key, 40);
    if (!KEY_RE.test(key) || used.has(key)) key = newKey('s', used);
    else used.add(key);
    const userIds = ids(s.userIds, 50);
    if (approverType === 'users' && !userIds.length) throw new ValidationError(`Bước ${i + 1}: chưa chọn người duyệt cụ thể`);
    const out = {
      key,
      name: str(s.name, 150) || `Bước ${i + 1}`,
      approverType,
      // users: danh sách người duyệt · requester_pick: (tuỳ chọn) chỉ được chọn trong danh sách này
      userIds: approverType === 'users' || approverType === 'requester_pick' ? userIds : [],
      mode: STEP_MODES.includes(s.mode) ? s.mode : 'all',
    };
    if (approverType === 'requester_pick') {
      if (bool(s.optional)) out.optional = true; // người gửi không chọn ai → bỏ qua bước này
      const maxPick = Number(s.maxPick);
      if (Number.isInteger(maxPick) && maxPick >= 1 && maxPick <= 20) out.maxPick = maxPick; // vd 1 = chỉ chọn 1 người
    }
    return out;
  });
}

function normalizeAudience(a) {
  if (!a || a.type !== 'targeted') return { type: 'all' };
  const out = { type: 'targeted', departmentIds: ids(a.departmentIds), teamIds: ids(a.teamIds), userIds: ids(a.userIds, 2000) };
  if (!out.departmentIds.length && !out.teamIds.length && !out.userIds.length) {
    throw new ValidationError('Chưa chọn phòng ban / tổ / người được gửi mẫu này');
  }
  return out;
}

function normalizeOptions(o = {}) {
  return {
    requireAttachment: bool(o.requireAttachment),
    allowAttachments: bool(o.allowAttachments, true),
    allowFollowers: bool(o.allowFollowers, true),
    allowPriority: bool(o.allowPriority, true),
    allowDeadline: bool(o.allowDeadline, true),
    titleHint: str(o.titleHint, 200),
  };
}

/** Chuẩn hoá toàn bộ mẫu đề xuất (admin gửi lên) */
function normalizeType(body) {
  const b = body || {};
  const name = str(b.name, 200);
  if (!name) throw new ValidationError('Chưa nhập tên mẫu đề xuất');
  const rawFields = Array.isArray(b.fields) ? b.fields : [];
  if (rawFields.length > MAX_FIELDS) throw new ValidationError(`Tối đa ${MAX_FIELDS} trường`);
  const used = new Set();
  const fields = rawFields.map((f) => normalizeField(f, used));
  checkComputed(fields);
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#2563eb';
  return {
    name,
    groupId: Number.isInteger(Number(b.groupId)) && Number(b.groupId) > 0 ? Number(b.groupId) : null,
    description: str(b.description, 2000) || null,
    icon: /^[A-Za-z0-9]{1,50}$/.test(b.icon || '') ? b.icon : 'FileText',
    color,
    fields,
    flow: normalizeFlow(b.flow),
    audience: normalizeAudience(b.audience),
    defaultFollowers: ids(b.defaultFollowers, 50),
    options: normalizeOptions(b.options),
    sortOrder: Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : 0,
    isActive: bool(b.isActive, true),
  };
}

function parseJson(s, fallback) {
  if (s === null || s === undefined) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Người dùng (profile: departmentId, teamId) có được gửi mẫu này không */
function audienceAllows(audience, userId, profile) {
  const a = parseJson(audience, { type: 'all' }) || { type: 'all' };
  if (a.type !== 'targeted') return true;
  return (a.userIds || []).includes(userId)
    || (!!profile?.departmentId && (a.departmentIds || []).includes(profile.departmentId))
    || (!!profile?.teamId && (a.teamIds || []).includes(profile.teamId));
}

/* ============================ GIÁ TRỊ NGƯỜI GỬI NHẬP ============================ */

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && !Array.isArray(v) && v.from === undefined && v.to === undefined && Object.keys(v).length === 0);
}

/**
 * Kiểm tra + chuẩn hoá giá trị theo danh sách trường.
 * @param fields  định nghĩa trường (đã chuẩn hoá)
 * @param input   { [fieldKey]: giá trị thô }
 * @param fileCountByField { [fieldKey]: số tệp đính kèm của trường loại 'files' }
 * @returns { values, userIds } — userIds: mọi id người dùng được chọn (để kiểm tra còn hoạt động)
 */
/** Chuẩn hoá các dòng của trường bảng: bỏ dòng trống, kiểm từng ô, tính cột "= A × B" */
function buildTableRows(f, v) {
  const src = Array.isArray(v) ? v : [];
  const rows = [];
  for (const [i, raw] of src.entries()) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const row = {};
    const at = (c) => `Bảng "${f.label}", dòng ${i + 1}, cột "${c.label}"`;
    for (const c of f.columns) {
      if (c.type === 'formula') continue;
      let x = r[c.key];
      if (typeof x === 'string') x = x.trim();
      if (x === undefined || x === null || x === '') continue;
      if (c.type === 'text') row[c.key] = String(x).slice(0, 1000);
      else if (c.type === 'number') {
        const n = Number(String(x).replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new ValidationError(`${at(c)}: phải là số`);
        row[c.key] = n;
      } else if (c.type === 'currency') {
        const n = Math.round(Number(typeof x === 'number' ? x : String(x).replace(/[^\d-]/g, '')));
        if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new ValidationError(`${at(c)}: số tiền không hợp lệ`);
        row[c.key] = n;
      } else if (c.type === 'date') {
        if (!isValidDate(x)) throw new ValidationError(`${at(c)}: ngày không hợp lệ`);
        row[c.key] = x;
      }
    }
    if (!Object.keys(row).length) continue; // dòng trống
    rows.push(computeRow(f.columns, row));
  }
  if (rows.length > (f.maxRows || 50)) throw new ValidationError(`Bảng "${f.label}" tối đa ${f.maxRows || 50} dòng`);
  return rows;
}

function buildValues(fields, input, fileCountByField = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const values = {};
  const userIds = new Set();
  for (const f of fields) {
    if (f.type === 'section') continue;
    if (f.sumOf || f.wordsOf) continue; // tự tính — xem cuối hàm (không nhận giá trị người dùng gửi)
    if (f.type === 'table') {
      const rows = buildTableRows(f, src[f.key]);
      if (f.required && !rows.length) throw new ValidationError(`Bảng "${f.label}" cần ít nhất 1 dòng`);
      if (rows.length) values[f.key] = rows;
      continue;
    }
    if (f.type === 'files') {
      const n = Number(fileCountByField[f.key] || 0);
      if (f.required && n === 0) throw new ValidationError(`Trường "${f.label}" cần ít nhất 1 tệp`);
      if (n > (f.maxFiles || 10)) throw new ValidationError(`Trường "${f.label}" tối đa ${f.maxFiles || 10} tệp`);
      continue;
    }
    let v = src[f.key];
    if (typeof v === 'string') v = v.trim();
    if (f.type === 'checkbox') {
      const checked = v === true || v === 'true' || v === 1;
      if (f.required && !checked) throw new ValidationError(`Vui lòng xác nhận "${f.label}"`);
      if (checked || v === false) values[f.key] = checked;
      continue;
    }
    if (isEmpty(v)) {
      if (f.required) throw new ValidationError(`Trường "${f.label}" là bắt buộc`);
      continue;
    }
    switch (f.type) {
      case 'text':
        values[f.key] = String(v).slice(0, 500);
        break;
      case 'textarea':
        if (String(v).length > 5000) throw new ValidationError(`Trường "${f.label}" tối đa 5000 ký tự`);
        values[f.key] = String(v);
        break;
      case 'number': {
        const n = Number(String(v).replace(',', '.'));
        if (!Number.isFinite(n)) throw new ValidationError(`Trường "${f.label}" phải là số`);
        if (f.min !== undefined && n < f.min) throw new ValidationError(`Trường "${f.label}" tối thiểu ${f.min}`);
        if (f.max !== undefined && n > f.max) throw new ValidationError(`Trường "${f.label}" tối đa ${f.max}`);
        values[f.key] = n;
        break;
      }
      case 'currency': {
        const n = Math.round(Number(String(v).replace(/[^\d-]/g, '')));
        if (!Number.isFinite(n) || n < 0 || n > 1e15) throw new ValidationError(`Trường "${f.label}": số tiền không hợp lệ`);
        values[f.key] = n;
        break;
      }
      case 'date':
        if (!isValidDate(v)) throw new ValidationError(`Trường "${f.label}": ngày không hợp lệ`);
        values[f.key] = v;
        break;
      case 'daterange': {
        const from = v?.from, to = v?.to;
        if (!isValidDate(from) || !isValidDate(to)) {
          if (f.required || from || to) throw new ValidationError(`Trường "${f.label}": chọn đủ từ ngày – đến ngày`);
          break;
        }
        if (from > to) throw new ValidationError(`Trường "${f.label}": ngày bắt đầu sau ngày kết thúc`);
        values[f.key] = { from, to };
        break;
      }
      case 'select': {
        const id = String(v);
        if (!f.options.some((o) => o.id === id)) throw new ValidationError(`Trường "${f.label}": lựa chọn không hợp lệ`);
        values[f.key] = id;
        break;
      }
      case 'multiselect': {
        const arr = [...new Set((Array.isArray(v) ? v : [v]).map(String))];
        if (arr.some((id) => !f.options.some((o) => o.id === id))) throw new ValidationError(`Trường "${f.label}": lựa chọn không hợp lệ`);
        if (!arr.length && f.required) throw new ValidationError(`Trường "${f.label}" là bắt buộc`);
        if (arr.length) values[f.key] = arr;
        break;
      }
      case 'user': {
        const arr = ids(Array.isArray(v) ? v : [v], 50);
        if (!arr.length) {
          if (f.required) throw new ValidationError(`Trường "${f.label}" là bắt buộc`);
          break;
        }
        const val = f.multiple ? arr : arr.slice(0, 1);
        val.forEach((id) => userIds.add(id));
        values[f.key] = f.multiple ? val : val[0];
        break;
      }
      default:
        break;
    }
  }
  // TỰ TÍNH: tổng 1 cột của bảng → rồi mới tới "bằng chữ" (có thể đọc chính trường tổng)
  for (const f of fields) {
    if (!f.sumOf) continue;
    const t = fields.find((x) => x.key === f.sumOf.table && x.type === 'table');
    const s = t ? columnSum(t.columns, values[t.key], f.sumOf.column) : null;
    if (s === null) {
      if (f.required) throw new ValidationError(`Trường "${f.label}": bảng "${t?.label || ''}" chưa có số liệu để tính tổng`);
      continue;
    }
    values[f.key] = f.type === 'currency' ? Math.round(s) : s;
  }
  for (const f of fields) {
    if (!f.wordsOf) continue;
    const n = values[f.wordsOf];
    if (!isNum(n)) {
      if (f.required) throw new ValidationError(`Trường "${f.label}": chưa có số tiền để đọc bằng chữ`);
      continue;
    }
    values[f.key] = moneyToWords(n);
  }
  return { values, userIds: [...userIds] };
}

/* ============================ QUY TRÌNH DUYỆT ============================ */

/**
 * Giải quy trình duyệt ra danh sách người duyệt theo bước.
 * - Bỏ người gửi khỏi danh sách duyệt; bước chỉ có chính người gửi → tự bỏ qua (ghi chú lại).
 * - Bước không tìm được ai → lỗi có thông báo cho người gửi.
 * - "Tổ trưởng" mà tổ chưa có tổ trưởng → lấy trưởng phòng.
 * @param flow     các bước (đã chuẩn hoá)
 * @param ctx      { requesterId, deptHeads:[id], teamHeads:[id], picked: {stepKey:[id]}, activeIds:Set<id>, hasDept, hasTeam }
 * @returns { steps: [{ stepNo, name, mode, userIds }], skipped: [tên bước] }
 */
function resolveFlow(flow, ctx) {
  const steps = [];
  const skipped = [];
  for (const [i, s] of flow.entries()) {
    let candidates = [];
    if (s.approverType === 'users') candidates = s.userIds;
    else if (s.approverType === 'dept_head') {
      if (!ctx.hasDept) throw new ValidationError(`Bước "${s.name}" do trưởng phòng duyệt nhưng bạn chưa có phòng ban — liên hệ quản trị viên`);
      candidates = ctx.deptHeads;
    } else if (s.approverType === 'team_head') {
      if (!ctx.hasDept && !ctx.hasTeam) throw new ValidationError(`Bước "${s.name}" do tổ trưởng duyệt nhưng bạn chưa có tổ/phòng ban — liên hệ quản trị viên`);
      candidates = ctx.teamHeads.length ? ctx.teamHeads : ctx.deptHeads;
    } else if (s.approverType === 'requester_pick') {
      candidates = ids(ctx.picked?.[s.key], 20);
      if (s.userIds.length) candidates = candidates.filter((id) => s.userIds.includes(id));
      if (s.maxPick) candidates = candidates.slice(0, s.maxPick);
      if (!candidates.length) {
        if (s.optional) continue; // bước không bắt buộc, người gửi không chọn ai → bỏ qua
        throw new ValidationError(`Bước "${s.name}": vui lòng chọn người duyệt`);
      }
    }
    let users = [...new Set(candidates)].filter((id) => ctx.activeIds.has(id));
    const hadRequester = users.includes(ctx.requesterId);
    users = users.filter((id) => id !== ctx.requesterId);
    if (!users.length) {
      if (hadRequester) { skipped.push(s.name); continue; }
      throw new ValidationError(`Bước "${s.name}" (bước ${i + 1}) chưa có người duyệt — liên hệ quản trị viên cấu hình`);
    }
    steps.push({ stepNo: steps.length + 1, name: s.name, mode: s.mode, userIds: users });
  }
  return { steps, skipped };
}

/** Mọi id người dùng mà quy trình cần kiểm tra còn hoạt động */
function flowUserIds(flow, picked) {
  const out = new Set();
  for (const s of flow) {
    s.userIds.forEach((id) => out.add(id));
    if (s.approverType === 'requester_pick') ids(picked?.[s.key], 20).forEach((id) => out.add(id));
  }
  return [...out];
}

module.exports = {
  ValidationError,
  FIELD_TYPES,
  APPROVER_TYPES,
  normalizeType,
  normalizeFlow,
  normalizeAudience,
  normalizeOptions,
  audienceAllows,
  buildValues,
  resolveFlow,
  flowUserIds,
  parseJson,
  isValidDate,
  ids,
  moneyToWords,
  columnSum,
};
