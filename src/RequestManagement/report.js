// RequestManagement/report.js — Module 18: BÁO CÁO TỰ THIẾT KẾ theo mẫu đề xuất
// Chuẩn hoá thiết kế báo cáo (lọc, nhóm theo, chỉ số) và tính kết quả từ danh sách đề xuất.
// Không truy cập DB — để kiểm thử độc lập (tools/rq-unit.js). Routes + truy vấn ở reports.js.
//
// Thiết kế (rq_Reports.definition):
//   period      kỳ mặc định: all today this_week this_month last_month this_quarter this_year last_year last_7 last_30 last_90 custom(+from,to)
//   dateBasis   created (ngày gửi) | finished (ngày kết thúc)
//   statuses    lọc trạng thái ([] = tất cả) · departmentIds ([] = mọi phòng) · priority ('high' = chỉ đề xuất Gấp)
//   groupBy     { by, field?, column? } — by ∈ DIMENSIONS; field = key trường của mẫu; column = key cột của trường bảng
//   metrics     [{ key, label, source, agg, field?, column?, statuses? }]
//               source: request (đếm đề xuất) · rows (đếm dòng của bảng) · field (trường số/tiền, kể cả trường tổng tự tính)
//                       column (cột số của bảng — tính trên từng dòng) · duration (số giờ từ lúc gửi đến lúc kết thúc)
//               agg: count (request/rows) · sum avg min max (field/column/duration)
//               statuses: chỉ tính đề xuất ở các trạng thái này (vd. "Tổng tiền đã duyệt")
//   chart       { type: bar|line|pie|none, metric }  · sort { by: label|<metricKey>, dir } · limit (0 = tất cả nhóm)
//   list        { show, columns: [ 'requestId','title','type','requester','department','team','status','priority','createdAt','finishedAt' | 'f:<fieldKey>' ] }
const D = require('./definition');

const DIMENSIONS = ['none', 'status', 'department', 'team', 'requester', 'type', 'priority', 'day', 'week', 'month', 'quarter', 'year', 'field', 'column'];
const TIME_DIMS = ['day', 'week', 'month', 'quarter', 'year'];
const SOURCES = ['request', 'rows', 'field', 'column', 'duration'];
const VALUE_AGGS = ['sum', 'avg', 'min', 'max'];
const PERIODS = ['all', 'today', 'this_week', 'this_month', 'last_month', 'this_quarter', 'this_year', 'last_year', 'last_7', 'last_30', 'last_90', 'custom'];
const STATUSES = ['pending', 'approved', 'rejected', 'returned', 'cancelled'];
const STATUS_LABEL = { pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối', returned: 'Cần bổ sung', cancelled: 'Đã huỷ' };
const BASE_COLUMNS = ['requestId', 'title', 'type', 'requester', 'department', 'team', 'status', 'priority', 'createdAt', 'finishedAt'];
// loại trường dùng để NHÓM THEO được (giá trị rời rạc)
const GROUP_FIELD_TYPES = ['select', 'multiselect', 'checkbox', 'user', 'text', 'date', 'daterange', 'number'];
const GROUP_COLUMN_TYPES = ['text', 'date', 'number'];
const MAX_METRICS = 12;
const MAX_LIST = 1000;
const EMPTY_KEY = '__empty';

const str = (v, max) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumericCol = (c) => !!c && (c.type === 'number' || c.type === 'currency' || c.type === 'formula');
const isMoneyCol = (cols, c) => c.type === 'currency' || (c.type === 'formula' && (c.of || []).some((k) => cols.find((x) => x.key === k)?.type === 'currency'));

/* ============================ KỲ BÁO CÁO ============================ */

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? utc(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Kỳ → { from, to } ('YYYY-MM-DD', tính cả 2 đầu; null = không giới hạn). today = 'YYYY-MM-DD' giờ VN */
function periodRange(period, today, custom = {}) {
  const t = parseYmd(today);
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
  const back = (n) => ({ from: ymdOf(utc(y, m, d - n + 1)), to: today });
  switch (period) {
    case 'today': return { from: today, to: today };
    case 'this_week': { const dow = (t.getUTCDay() + 6) % 7; return { from: ymdOf(utc(y, m, d - dow)), to: ymdOf(utc(y, m, d - dow + 6)) }; }
    case 'this_month': return { from: ymdOf(utc(y, m, 1)), to: ymdOf(utc(y, m + 1, 0)) };
    case 'last_month': return { from: ymdOf(utc(y, m - 1, 1)), to: ymdOf(utc(y, m, 0)) };
    case 'this_quarter': { const q = Math.floor(m / 3) * 3; return { from: ymdOf(utc(y, q, 1)), to: ymdOf(utc(y, q + 3, 0)) }; }
    case 'this_year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'last_year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'last_7': return back(7);
    case 'last_30': return back(30);
    case 'last_90': return back(90);
    case 'custom': {
      const from = D.isValidDate(custom.from) ? custom.from : null;
      const to = D.isValidDate(custom.to) ? custom.to : null;
      return from && to && from > to ? { from: to, to: from } : { from, to };
    }
    default: return { from: null, to: null };
  }
}

/* ============================ CHUẨN HOÁ THIẾT KẾ ============================ */

/**
 * Chuẩn hoá thiết kế báo cáo admin gửi lên.
 * @param body   { name, description, typeId, viewerIds, definition }
 * @param fields trường hiện tại của mẫu (null khi báo cáo cho mọi mẫu → chỉ dùng chiều/chỉ số chung)
 */
function normalizeReport(body, fields) {
  const b = body || {};
  const name = str(b.name, 200);
  if (!name) throw new D.ValidationError('Chưa nhập tên báo cáo');
  const typeId = Number.isInteger(Number(b.typeId)) && Number(b.typeId) > 0 ? Number(b.typeId) : null;
  return {
    name,
    description: str(b.description, 1000) || null,
    typeId,
    viewerIds: D.ids(b.viewerIds, 200),
    sortOrder: Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : 0,
    definition: normalizeDefinition(b.definition, typeId ? fields || [] : null),
  };
}

function normalizeDefinition(def, fields) {
  const x = def && typeof def === 'object' ? def : {};
  const byKey = new Map((fields || []).map((f) => [f.key, f]));
  const out = {
    period: PERIODS.includes(x.period) ? x.period : 'this_month',
    dateBasis: x.dateBasis === 'finished' ? 'finished' : 'created',
    statuses: [...new Set((Array.isArray(x.statuses) ? x.statuses : []).filter((s) => STATUSES.includes(s)))],
    departmentIds: D.ids(x.departmentIds, 100),
    priority: x.priority === 'high' ? 'high' : null,
  };
  if (out.period === 'custom') {
    out.from = D.isValidDate(x.from) ? x.from : null;
    out.to = D.isValidDate(x.to) ? x.to : null;
  }

  // NHÓM THEO
  const g = x.groupBy && typeof x.groupBy === 'object' ? x.groupBy : {};
  const by = DIMENSIONS.includes(g.by) ? g.by : 'none';
  out.groupBy = { by };
  if (by === 'field' || by === 'column') {
    const f = byKey.get(str(g.field, 40));
    if (!fields) throw new D.ValidationError('Nhóm theo trường thông tin cần chọn 1 mẫu đề xuất');
    if (by === 'field') {
      if (!f || !GROUP_FIELD_TYPES.includes(f.type)) throw new D.ValidationError('Nhóm theo: chọn lại trường thông tin');
      out.groupBy.field = f.key;
    } else {
      const c = f?.type === 'table' ? (f.columns || []).find((col) => col.key === str(g.column, 40)) : null;
      if (!c || !GROUP_COLUMN_TYPES.includes(c.type)) throw new D.ValidationError('Nhóm theo: chọn lại cột của bảng');
      out.groupBy.field = f.key;
      out.groupBy.column = c.key;
    }
  }

  // CHỈ SỐ
  const raw = Array.isArray(x.metrics) ? x.metrics : [];
  if (!raw.length) throw new D.ValidationError('Báo cáo cần ít nhất 1 chỉ số');
  if (raw.length > MAX_METRICS) throw new D.ValidationError(`Tối đa ${MAX_METRICS} chỉ số`);
  const used = new Set();
  out.metrics = raw.map((m, i) => {
    const source = SOURCES.includes(m?.source) ? m.source : 'request';
    let key = str(m?.key, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || used.has(key)) key = `m${i + 1}`;
    while (used.has(key)) key = `${key}_`;
    used.add(key);
    const label = str(m?.label, 150) || `Chỉ số ${i + 1}`;
    const metric = { key, label, source };
    if (source === 'request') metric.agg = 'count';
    else if (source === 'duration') metric.agg = VALUE_AGGS.includes(m.agg) ? m.agg : 'avg';
    else {
      if (!fields) throw new D.ValidationError(`Chỉ số "${label}": cần chọn 1 mẫu đề xuất`);
      const f = byKey.get(str(m.field, 40));
      if (source === 'field') {
        if (!f || (f.type !== 'number' && f.type !== 'currency')) throw new D.ValidationError(`Chỉ số "${label}": chọn lại trường số / số tiền`);
        metric.field = f.key;
        metric.agg = VALUE_AGGS.includes(m.agg) ? m.agg : 'sum';
      } else if (source === 'rows') {
        if (!f || f.type !== 'table') throw new D.ValidationError(`Chỉ số "${label}": chọn lại bảng`);
        metric.field = f.key;
        metric.agg = 'count';
      } else {
        const c = f?.type === 'table' ? (f.columns || []).find((col) => col.key === str(m.column, 40)) : null;
        if (!isNumericCol(c)) throw new D.ValidationError(`Chỉ số "${label}": chọn lại cột số của bảng`);
        metric.field = f.key;
        metric.column = c.key;
        metric.agg = VALUE_AGGS.includes(m.agg) ? m.agg : 'sum';
      }
    }
    const st = [...new Set((Array.isArray(m?.statuses) ? m.statuses : []).filter((s) => STATUSES.includes(s)))];
    if (st.length) metric.statuses = st;
    return metric;
  });

  // BIỂU ĐỒ / SẮP XẾP / GIỚI HẠN
  const ch = x.chart && typeof x.chart === 'object' ? x.chart : {};
  out.chart = {
    type: ['bar', 'line', 'pie', 'none'].includes(ch.type) ? ch.type : TIME_DIMS.includes(by) ? 'line' : 'bar',
    metric: out.metrics.some((m) => m.key === ch.metric) ? ch.metric : out.metrics[0].key,
  };
  if (by === 'none') out.chart.type = 'none';
  const so = x.sort && typeof x.sort === 'object' ? x.sort : {};
  const sortBy = so.by === 'label' || out.metrics.some((m) => m.key === so.by) ? so.by : TIME_DIMS.includes(by) || by === 'status' ? 'label' : out.metrics[0].key;
  out.sort = { by: sortBy, dir: so.dir === 'asc' || so.dir === 'desc' ? so.dir : sortBy === 'label' ? 'asc' : 'desc' };
  out.limit = Math.min(100, Math.max(0, parseInt(x.limit, 10) || 0));

  // DANH SÁCH ĐỀ XUẤT
  const li = x.list && typeof x.list === 'object' ? x.list : {};
  const cols = (Array.isArray(li.columns) ? li.columns : []).map((c) => str(c, 45))
    .filter((c) => BASE_COLUMNS.includes(c) || (fields && c.startsWith('f:') && byKey.has(c.slice(2)) && byKey.get(c.slice(2)).type !== 'section' && byKey.get(c.slice(2)).type !== 'files'));
  out.list = { show: li.show === undefined ? true : !!li.show, columns: [...new Set(cols)].slice(0, 30) };
  if (!out.list.columns.length) out.list.columns = ['requestId', 'title', 'requester', 'department', 'status', 'createdAt'];
  return out;
}

/* ============================ TÍNH KẾT QUẢ ============================ */

/** Chuỗi giờ VN 'YYYY-MM-DDTHH:mm:ss' → giá trị thời gian của nhóm */
function timeBucket(by, s) {
  const d = parseYmd(s);
  if (!d) return { key: EMPTY_KEY, label: '(Chưa kết thúc)', sort: '9999' };
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (by === 'day') return { key: ymdOf(d), label: `${pad(d.getUTCDate())}/${pad(m)}/${y}`, sort: ymdOf(d) };
  if (by === 'week') {
    const mon = utc(y, m - 1, d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const sun = utc(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate() + 6);
    return { key: ymdOf(mon), label: `${pad(mon.getUTCDate())}/${pad(mon.getUTCMonth() + 1)} – ${pad(sun.getUTCDate())}/${pad(sun.getUTCMonth() + 1)}/${sun.getUTCFullYear()}`, sort: ymdOf(mon) };
  }
  if (by === 'month') return { key: `${y}-${pad(m)}`, label: `Tháng ${m}/${y}`, sort: `${y}-${pad(m)}` };
  if (by === 'quarter') { const q = Math.ceil(m / 3); return { key: `${y}-Q${q}`, label: `Quý ${q}/${y}`, sort: `${y}-${q}` }; }
  return { key: String(y), label: `Năm ${y}`, sort: String(y) };
}

const fmtNum = (n) => (isNum(n) ? n.toLocaleString('vi-VN', { maximumFractionDigits: 4 }) : String(n));
const empty = () => ({ key: EMPTY_KEY, label: '(Trống)', sort: '￿' });

/** Các nhóm mà 1 đề xuất thuộc về: [{ key, label, sort, rows? }] (rows = các dòng bảng thuộc nhóm, khi nhóm theo cột) */
function bucketsOf(r, g, ctx) {
  switch (g.by) {
    case 'none': return [{ key: 'all', label: 'Tất cả', sort: '' }];
    case 'status': return [{ key: r.status, label: STATUS_LABEL[r.status] || r.status, sort: String(STATUSES.indexOf(r.status)).padStart(2, '0') }];
    case 'department': return [r.departmentId ? { key: `d${r.departmentId}`, label: r.departmentName || `Phòng #${r.departmentId}`, sort: r.departmentName || '' } : { key: EMPTY_KEY, label: '(Chưa có phòng ban)', sort: '￿' }];
    case 'team': return [r.teamId ? { key: `t${r.teamId}`, label: r.teamName || `Tổ #${r.teamId}`, sort: r.teamName || '' } : { key: EMPTY_KEY, label: '(Chưa có tổ)', sort: '￿' }];
    case 'requester': return [{ key: `u${r.requesterId}`, label: r.requesterName || `Người dùng #${r.requesterId}`, sort: r.requesterName || '' }];
    case 'type': return [{ key: `k${r.typeId}`, label: r.typeName || `Mẫu #${r.typeId}`, sort: r.typeName || '' }];
    case 'priority': return [r.priority === 'high' ? { key: 'high', label: 'Gấp', sort: '0' } : { key: 'normal', label: 'Bình thường', sort: '1' }];
    case 'field': {
      const f = ctx.fieldByKey.get(g.field);
      const v = r.values?.[g.field];
      if (!f) return [empty()];
      if (f.type === 'checkbox') return [v === true ? { key: 'yes', label: 'Có', sort: '0' } : { key: 'no', label: 'Không', sort: '1' }];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return [empty()];
      if (f.type === 'select' || f.type === 'multiselect') {
        const list = [...new Set(Array.isArray(v) ? v : [v])];
        return list.map((id) => {
          const i = (f.options || []).findIndex((o) => o.id === id);
          return { key: `o${id}`, label: i >= 0 ? f.options[i].label : '(Lựa chọn đã xoá)', sort: i >= 0 ? String(i).padStart(4, '0') : '￿' };
        });
      }
      if (f.type === 'user') return [...new Set(Array.isArray(v) ? v : [v])].map((id) => ({ key: `u${id}`, label: ctx.userName(id), sort: ctx.userName(id) }));
      if (f.type === 'date') return [{ key: v, label: timeBucket('day', v).label, sort: v }];
      if (f.type === 'daterange') return v.from ? [{ key: v.from, label: timeBucket('day', v.from).label, sort: v.from }] : [empty()];
      if (f.type === 'number') return [{ key: `n${v}`, label: `${fmtNum(v)}${f.unit ? ` ${f.unit}` : ''}`, sort: String(1e15 + Number(v)).padStart(20, '0') }];
      const text = String(v).trim().replace(/\s+/g, ' ').slice(0, 120);
      return [{ key: `s${text.toLowerCase()}`, label: text, sort: text.toLowerCase() }];
    }
    case 'column': {
      const f = ctx.fieldByKey.get(g.field);
      const c = f?.columns?.find((x) => x.key === g.column);
      const rows = Array.isArray(r.values?.[g.field]) ? r.values[g.field] : [];
      if (!c || !rows.length) return [];
      const map = new Map();
      for (const row of rows) {
        const v = row?.[c.key];
        let b;
        if (v === undefined || v === null || String(v).trim() === '') b = empty();
        else if (c.type === 'date') b = { key: v, label: timeBucket('day', v).label, sort: v };
        else if (c.type === 'number') b = { key: `n${v}`, label: fmtNum(Number(v)), sort: String(1e15 + Number(v)).padStart(20, '0') };
        else { const text = String(v).trim().replace(/\s+/g, ' ').slice(0, 120); b = { key: `s${text.toLowerCase()}`, label: text, sort: text.toLowerCase() }; }
        if (!map.has(b.key)) map.set(b.key, { ...b, rows: [] });
        map.get(b.key).rows.push(row);
      }
      return [...map.values()];
    }
    default:
      return TIME_DIMS.includes(g.by) ? [timeBucket(g.by, ctx.dateOf(r))] : [{ key: 'all', label: 'Tất cả', sort: '' }];
  }
}

/** Giá trị của 1 chỉ số trên 1 đề xuất (trong 1 nhóm) → mảng số, hoặc số lượng để đếm */
function metricInputs(m, r, groupRows) {
  if (m.statuses && !m.statuses.includes(r.status)) return null;
  if (m.source === 'request') return { count: 1 };
  if (m.source === 'duration') {
    const a = Date.parse(`${r.createdAt}Z`), b = Date.parse(`${r.finishedAt}Z`);
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? { nums: [(b - a) / 3600000] } : { nums: [] };
  }
  if (m.source === 'field') {
    const v = r.values?.[m.field];
    return { nums: isNum(v) ? [v] : [] };
  }
  // rows / column: nhóm theo cột của CHÍNH bảng này → chỉ các dòng trong nhóm; bảng khác → mọi dòng
  const rows = groupRows && m.field === m.__groupTable ? groupRows : Array.isArray(r.values?.[m.field]) ? r.values[m.field] : [];
  if (m.source === 'rows') return { count: rows.length };
  return { nums: rows.map((x) => x?.[m.column]).filter(isNum) };
}

const newAcc = () => ({ count: 0, n: 0, sum: 0, min: null, max: null });
function addAcc(acc, inp) {
  if (!inp) return;
  if (inp.count !== undefined) acc.count += inp.count;
  for (const v of inp.nums || []) {
    acc.n++;
    acc.sum += v;
    acc.min = acc.min === null ? v : Math.min(acc.min, v);
    acc.max = acc.max === null ? v : Math.max(acc.max, v);
  }
}
function mergeAcc(a, b) {
  return { count: a.count + b.count, n: a.n + b.n, sum: a.sum + b.sum, min: a.min === null ? b.min : b.min === null ? a.min : Math.min(a.min, b.min), max: a.max === null ? b.max : b.max === null ? a.max : Math.max(a.max, b.max) };
}
const round = (v, money) => (v === null ? null : money ? Math.round(v) : Math.round(v * 100) / 100);
function accValue(m, acc, money) {
  if (m.agg === 'count') return acc.count;
  if (!acc.n) return null;
  if (m.agg === 'sum') return round(acc.sum, money);
  if (m.agg === 'avg') return round(acc.sum / acc.n, money);
  return round(m.agg === 'min' ? acc.min : acc.max, money);
}

/** Định dạng hiển thị của chỉ số: int | money | number | hours (+ unit) */
function metricFormat(m, fieldByKey) {
  if (m.agg === 'count') return { format: 'int' };
  if (m.source === 'duration') return { format: 'hours' };
  const f = fieldByKey.get(m.field);
  if (m.source === 'field') return f?.type === 'currency' ? { format: 'money' } : { format: 'number', unit: f?.unit };
  const c = f?.columns?.find((x) => x.key === m.column);
  return c && isMoneyCol(f.columns, c) ? { format: 'money' } : { format: 'number' };
}

/**
 * Tính báo cáo.
 * @param def      thiết kế đã chuẩn hoá
 * @param requests [{ requestId, typeId, typeName, title, requesterId, requesterName, departmentId, departmentName, teamId, teamName,
 *                   status, priority, createdAt, finishedAt, values }]  (đã lọc theo kỳ / trạng thái / phòng ở SQL)
 * @param ctx      { fields (trường hiện tại của mẫu, [] nếu báo cáo mọi mẫu), userName(id) }
 */
function runReport(def, requests, ctx = {}) {
  const fieldByKey = new Map((ctx.fields || []).map((f) => [f.key, f]));
  const c = {
    fieldByKey,
    userName: ctx.userName || ((id) => `Người dùng #${id}`),
    dateOf: (r) => (def.dateBasis === 'finished' ? r.finishedAt : r.createdAt),
  };
  // chỉ số / chiều trỏ tới trường đã bị xoá khỏi mẫu → bỏ qua, báo lại
  const warnings = [];
  const metrics = def.metrics.filter((m) => {
    if (m.source === 'request' || m.source === 'duration') return true;
    const f = fieldByKey.get(m.field);
    const ok = m.source === 'field' ? f && (f.type === 'number' || f.type === 'currency')
      : m.source === 'rows' ? f?.type === 'table'
        : f?.type === 'table' && isNumericCol(f.columns.find((x) => x.key === m.column));
    if (!ok) warnings.push(`Chỉ số "${m.label}" trỏ tới trường không còn trong mẫu — đã bỏ qua`);
    return ok;
  }).map((m) => ({ ...m, __groupTable: def.groupBy.by === 'column' ? def.groupBy.field : null, ...metricFormat(m, fieldByKey) }));
  let g = def.groupBy;
  if ((g.by === 'field' || g.by === 'column') && !fieldByKey.has(g.field)) {
    warnings.push('Trường dùng để nhóm không còn trong mẫu — hiển thị tổng chung');
    g = { by: 'none' };
  }

  const groups = new Map();
  const totals = metrics.map(() => newAcc());
  for (const r of requests) {
    for (const [i, m] of metrics.entries()) addAcc(totals[i], metricInputs({ ...m, __groupTable: null }, r, null));
    const seen = new Set();
    for (const b of bucketsOf(r, g, c)) {
      if (seen.has(b.key)) continue;
      seen.add(b.key);
      if (!groups.has(b.key)) groups.set(b.key, { key: b.key, label: b.label, sort: b.sort, requests: 0, accs: metrics.map(() => newAcc()) });
      const grp = groups.get(b.key);
      grp.requests++;
      metrics.forEach((m, i) => addAcc(grp.accs[i], metricInputs(m, r, b.rows || null)));
    }
  }

  let list = [...groups.values()];
  const sortIdx = metrics.findIndex((m) => m.key === def.sort.by);
  const money = metrics.map((m) => m.format === 'money');
  const dir = def.sort.dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (sortIdx >= 0) {
      const x = accValue(metrics[sortIdx], a.accs[sortIdx], money[sortIdx]) ?? -Infinity;
      const y = accValue(metrics[sortIdx], b.accs[sortIdx], money[sortIdx]) ?? -Infinity;
      if (x !== y) return (x - y) * dir;
    }
    return String(a.sort).localeCompare(String(b.sort), 'vi') * (sortIdx >= 0 ? 1 : dir);
  });
  let others = null;
  if (def.limit > 0 && list.length > def.limit) {
    const rest = list.slice(def.limit);
    list = list.slice(0, def.limit);
    others = { key: '__others', label: `Khác (${rest.length} nhóm)`, requests: rest.reduce((a, x) => a + x.requests, 0), accs: metrics.map((_, i) => rest.reduce((a, x) => mergeAcc(a, x.accs[i]), newAcc())) };
  }
  const out = (grp) => ({ key: grp.key, label: grp.label, requests: grp.requests, values: Object.fromEntries(metrics.map((m, i) => [m.key, accValue(m, grp.accs[i], money[i])])) });

  return {
    metrics: metrics.map(({ __groupTable, ...m }) => m),
    groupBy: g,
    groups: [...list.map(out), ...(others ? [out(others)] : [])],
    totals: Object.fromEntries(metrics.map((m, i) => [m.key, accValue(m, totals[i], money[i])])),
    requestCount: requests.length,
    warnings,
  };
}

/** Danh sách đề xuất kèm cột đã chọn (mới nhất trước, tối đa MAX_LIST dòng) */
function listRows(def, requests) {
  const keys = def.list.columns.filter((c) => c.startsWith('f:')).map((c) => c.slice(2));
  return requests.slice(0, MAX_LIST).map((r) => ({
    requestId: r.requestId, title: r.title, typeName: r.typeName, requesterName: r.requesterName,
    departmentName: r.departmentName, teamName: r.teamName, status: r.status, priority: r.priority,
    createdAt: r.createdAt, finishedAt: r.finishedAt,
    values: Object.fromEntries(keys.filter((k) => r.values?.[k] !== undefined).map((k) => [k, r.values[k]])),
  }));
}

/** id người dùng xuất hiện trong trường "Chọn nhân viên" (để tra tên khi nhóm theo trường đó) */
function userIdsFor(def, requests, fields) {
  const g = def.groupBy;
  const f = g.by === 'field' ? (fields || []).find((x) => x.key === g.field) : null;
  if (f?.type !== 'user') return [];
  const out = new Set();
  for (const r of requests) {
    const v = r.values?.[f.key];
    (Array.isArray(v) ? v : [v]).forEach((id) => Number.isInteger(id) && out.add(id));
  }
  return [...out];
}

module.exports = {
  DIMENSIONS, SOURCES, PERIODS, MAX_LIST,
  periodRange, normalizeReport, normalizeDefinition, runReport, listRows, userIdsFor,
};
