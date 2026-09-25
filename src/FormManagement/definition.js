// FormManagement/definition.js
// Quy tắc của biểu mẫu: loại câu hỏi, chuẩn hoá định nghĩa từ trang tạo biểu mẫu,
// điều kiện hiện câu hỏi (showIf), kiểm tra & chuyển đổi câu trả lời khi nộp.
// Logic điều kiện phải giống hệt frontend: dashboardDuanRac/src/pagesForm/shared/conditions.js

const QUESTION_TYPES = [
  'section', 'short_text', 'long_text', 'number', 'currency',
  'single_choice', 'multiple_choice', 'dropdown', 'yes_no',
  'linear_scale', 'rating', 'date',
];
const CHOICE_TYPES = ['single_choice', 'multiple_choice', 'dropdown'];
const NUMERIC_TYPES = ['number', 'currency', 'linear_scale', 'rating'];
const OTHER_ID = '__other__';
const CONDITION_OPS = ['eq', 'neq', 'answered'];

const LIMITS = {
  title: 300,
  description: 4000,
  label: 1000,
  questionDescription: 2000,
  questions: 200,
  options: 100,
  optionLabel: 300,
  text: 4000,
  thankYou: 1000,
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 'YYYY-MM-DDTHH:mm[:ss]' (giờ địa phương) → 'YYYY-MM-DDTHH:mm:ss' | null */
function normalizeLocalDateTime(v, field) {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/);
  if (!m) throw new ValidationError(`${field} không đúng định dạng ngày giờ`);
  return `${m[1]}T${m[2]}${m[3] || ':00'}`;
}

/* ============================ ĐỊNH NGHĨA BIỂU MẪU ============================ */

function normalizeOptions(raw, label) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError(`Câu "${label}" cần ít nhất 1 lựa chọn`);
  }
  if (raw.length > LIMITS.options) throw new ValidationError(`Câu "${label}" có quá nhiều lựa chọn`);
  const seen = new Set();
  return raw.map((o, i) => {
    const id = str(o?.id).slice(0, 40) || `o${i + 1}`;
    const optLabel = str(o?.label);
    if (!optLabel) throw new ValidationError(`Câu "${label}": lựa chọn thứ ${i + 1} đang để trống`);
    if (optLabel.length > LIMITS.optionLabel) throw new ValidationError(`Câu "${label}": lựa chọn quá dài`);
    if (seen.has(id) || id === OTHER_ID) throw new ValidationError(`Câu "${label}": mã lựa chọn bị trùng`);
    seen.add(id);
    return { id, label: optLabel };
  });
}

function normalizeSettings(type, raw, label) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  if (type === 'short_text') {
    out.inputKind = ['text', 'email', 'phone'].includes(s.inputKind) ? s.inputKind : 'text';
    if (str(s.placeholder)) out.placeholder = str(s.placeholder).slice(0, 200);
  }
  if (type === 'long_text' && str(s.placeholder)) out.placeholder = str(s.placeholder).slice(0, 200);

  if (type === 'number' || type === 'currency') {
    const min = num(s.min), max = num(s.max);
    if (min !== null && !Number.isFinite(min)) throw new ValidationError(`Câu "${label}": giá trị nhỏ nhất không hợp lệ`);
    if (max !== null && !Number.isFinite(max)) throw new ValidationError(`Câu "${label}": giá trị lớn nhất không hợp lệ`);
    if (min !== null && max !== null && min > max) throw new ValidationError(`Câu "${label}": nhỏ nhất lớn hơn lớn nhất`);
    if (min !== null) out.min = min;
    if (max !== null) out.max = max;
    const unit = str(s.unit).slice(0, 20);
    if (unit) out.unit = unit;
    else if (type === 'currency') out.unit = 'VNĐ';
  }

  if (CHOICE_TYPES.includes(type)) {
    out.options = normalizeOptions(s.options, label);
    if (type !== 'dropdown' && s.allowOther) out.allowOther = true;
    if (type === 'multiple_choice') {
      const maxSelect = num(s.maxSelect);
      if (maxSelect !== null && maxSelect >= 1) out.maxSelect = Math.floor(maxSelect);
    }
  }

  if (type === 'yes_no') {
    out.yesLabel = str(s.yesLabel).slice(0, 50) || 'Có';
    out.noLabel = str(s.noLabel).slice(0, 50) || 'Không';
  }

  if (type === 'linear_scale') {
    const min = num(s.min) ?? 1, max = num(s.max) ?? 5;
    if (![0, 1].includes(min) || !Number.isInteger(max) || max < 2 || max > 10) {
      throw new ValidationError(`Câu "${label}": thang điểm phải bắt đầu từ 0 hoặc 1 và tối đa 2–10`);
    }
    out.min = min;
    out.max = max;
    if (str(s.minLabel)) out.minLabel = str(s.minLabel).slice(0, 60);
    if (str(s.maxLabel)) out.maxLabel = str(s.maxLabel).slice(0, 60);
  }

  if (type === 'rating') {
    const max = num(s.max) ?? 5;
    if (!Number.isInteger(max) || max < 3 || max > 10) throw new ValidationError(`Câu "${label}": số sao phải từ 3 đến 10`);
    out.max = max;
  }

  return out;
}

function normalizeShowIf(raw, earlierByKey, label) {
  if (!raw || typeof raw !== 'object' || !str(raw.questionKey)) return null;
  const target = earlierByKey.get(str(raw.questionKey));
  if (!target) throw new ValidationError(`Câu "${label}": điều kiện hiện phải dựa trên một câu hỏi đứng trước nó`);
  const op = CONDITION_OPS.includes(raw.op) ? raw.op : 'eq';
  const out = { questionKey: target.questionKey, op };
  if (op !== 'answered') {
    const value = str(raw.value);
    if (!value) throw new ValidationError(`Câu "${label}": điều kiện hiện chưa chọn giá trị`);
    out.value = value.slice(0, 300);
  }
  return out;
}

/**
 * Chuẩn hoá payload từ trang tạo biểu mẫu. Ném ValidationError nếu sai.
 */
function normalizeDefinition(body) {
  const b = body && typeof body === 'object' ? body : {};
  const title = str(b.title);
  if (!title) throw new ValidationError('Chưa nhập tên biểu mẫu');
  if (title.length > LIMITS.title) throw new ValidationError('Tên biểu mẫu quá dài');
  const description = str(b.description);
  if (description.length > LIMITS.description) throw new ValidationError('Mô tả quá dài');

  const openAt = normalizeLocalDateTime(b.openAt, 'Thời gian mở');
  const closeAt = normalizeLocalDateTime(b.closeAt, 'Hạn chót');
  if (openAt && closeAt && openAt >= closeAt) throw new ValidationError('Hạn chót phải sau thời gian mở');

  const audienceType = b.audienceType === 'targeted' ? 'targeted' : 'all';
  const audiences = [];
  if (audienceType === 'targeted') {
    const seen = new Set();
    for (const a of Array.isArray(b.audiences) ? b.audiences : []) {
      const targetType = ['department', 'team', 'jobTitle', 'user'].includes(a?.targetType) ? a.targetType : null;
      const targetId = Number(a?.targetId);
      if (!targetType || !Number.isInteger(targetId) || targetId <= 0) continue;
      const key = `${targetType}:${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      audiences.push({ targetType, targetId });
    }
    if (audiences.length === 0) throw new ValidationError('Chưa chọn đối tượng được xem biểu mẫu');
  }

  const rawQuestions = Array.isArray(b.questions) ? b.questions : [];
  if (rawQuestions.length > LIMITS.questions) throw new ValidationError(`Tối đa ${LIMITS.questions} câu hỏi`);

  const questions = [];
  const earlierByKey = new Map();
  const seenKeys = new Set();
  for (const [i, q] of rawQuestions.entries()) {
    const type = QUESTION_TYPES.includes(q?.type) ? q.type : null;
    if (!type) throw new ValidationError(`Câu thứ ${i + 1} có loại không hợp lệ`);
    const label = str(q.label);
    if (!label) throw new ValidationError(type === 'section' ? `Phần thứ ${i + 1} chưa có tiêu đề` : `Câu thứ ${i + 1} chưa nhập nội dung câu hỏi`);
    if (label.length > LIMITS.label) throw new ValidationError(`Câu thứ ${i + 1} quá dài`);
    const qDesc = str(q.description);
    if (qDesc.length > LIMITS.questionDescription) throw new ValidationError(`Mô tả của câu "${label}" quá dài`);

    const questionKey = str(q.questionKey).slice(0, 40);
    if (!questionKey || !/^[A-Za-z0-9_-]+$/.test(questionKey)) throw new ValidationError(`Câu "${label}" thiếu mã câu hỏi`);
    if (seenKeys.has(questionKey)) throw new ValidationError(`Mã câu hỏi bị trùng: ${questionKey}`);
    seenKeys.add(questionKey);

    const settings = type === 'section' ? {} : normalizeSettings(type, q.settings, label);
    const showIf = normalizeShowIf(q.settings?.showIf, earlierByKey, label);
    if (showIf) settings.showIf = showIf;

    const item = {
      questionKey,
      type,
      label,
      description: qDesc || null,
      isRequired: type === 'section' ? false : !!q.isRequired,
      settings,
    };
    questions.push(item);
    if (type !== 'section') earlierByKey.set(questionKey, item);
  }

  const thankYouMessage = str(b.thankYouMessage);
  if (thankYouMessage.length > LIMITS.thankYou) throw new ValidationError('Lời cảm ơn quá dài');
  const themeColor = /^#[0-9a-fA-F]{6}$/.test(str(b.themeColor)) ? str(b.themeColor) : null;

  return {
    title,
    description: description || null,
    isVisible: !!b.isVisible,
    acceptResponses: b.acceptResponses === undefined ? true : !!b.acceptResponses,
    openAt,
    closeAt,
    audienceType,
    audiences,
    allowEditAfterSubmit: b.allowEditAfterSubmit === undefined ? true : !!b.allowEditAfterSubmit,
    allowMultiple: !!b.allowMultiple,
    requireProfile: b.requireProfile === undefined ? true : !!b.requireProfile,
    themeColor,
    thankYouMessage: thankYouMessage || null,
    questions,
  };
}

/* ============================ ĐIỀU KIỆN HIỆN CÂU HỎI ============================ */

/** Câu trả lời dạng "raw" (giống frontend gửi lên) có được coi là đã trả lời không */
function isAnswered(type, v) {
  if (v === undefined || v === null) return false;
  if (CHOICE_TYPES.includes(type)) {
    if (type === 'multiple_choice') return Array.isArray(v?.optionIds) && (v.optionIds.length > 0);
    return !!str(v?.optionId);
  }
  if (NUMERIC_TYPES.includes(type)) return v !== '' && Number.isFinite(Number(v));
  return !!str(v);
}

/** So khớp điều kiện với câu trả lời raw của câu hỏi được tham chiếu */
function matchCondition(cond, refType, refValue) {
  const answered = isAnswered(refType, refValue);
  if (cond.op === 'answered') return answered;
  let equal = false;
  if (answered) {
    if (refType === 'multiple_choice') equal = refValue.optionIds.map(String).includes(cond.value);
    else if (CHOICE_TYPES.includes(refType)) equal = String(refValue.optionId) === cond.value;
    else equal = str(refValue) === cond.value;
  }
  return cond.op === 'eq' ? equal : !equal;
}

/**
 * Tính tập câu hỏi đang hiện, theo thứ tự. Câu bị ẩn coi như chưa trả lời
 * (điều kiện dây chuyền). Câu section không bao giờ ẩn.
 * @param questions [{questionKey, type, settings}]
 * @param rawByKey  { [questionKey]: rawValue }
 */
function visibleQuestionKeys(questions, rawByKey) {
  const visible = new Set();
  const byKey = new Map(questions.map((q) => [q.questionKey, q]));
  for (const q of questions) {
    const cond = q.settings?.showIf;
    if (!cond) { visible.add(q.questionKey); continue; }
    const ref = byKey.get(cond.questionKey);
    const refValue = ref && visible.has(ref.questionKey) ? rawByKey[ref.questionKey] : undefined;
    if (ref && matchCondition(cond, ref.type, refValue)) visible.add(q.questionKey);
  }
  return visible;
}

/* ============================ CÂU TRẢ LỜI ============================ */

const fmtNumber = (n) => Number(n).toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/**
 * Kiểm tra câu trả lời & chuyển sang dạng lưu DB.
 * @param questions  câu hỏi đang hoạt động của form (đã parse settings), theo thứ tự
 * @param rawAnswers { [questionId]: rawValue }
 * @returns [{questionId, valueText, valueNumber, valueJson, valueDisplay}]
 */
function buildAnswerRows(questions, rawAnswers) {
  const raw = rawAnswers && typeof rawAnswers === 'object' ? rawAnswers : {};
  const rawByKey = {};
  for (const q of questions) rawByKey[q.questionKey] = raw[q.questionId];
  const visible = visibleQuestionKeys(questions, rawByKey);

  const rows = [];
  const missing = [];
  for (const q of questions) {
    if (q.type === 'section' || !visible.has(q.questionKey)) continue;
    const v = raw[q.questionId];
    const s = q.settings || {};

    if (!isAnswered(q.type, v)) {
      if (q.isRequired) missing.push(q.label);
      continue;
    }

    const row = { questionId: q.questionId, valueText: null, valueNumber: null, valueJson: null, valueDisplay: null };
    const fail = (msg) => { throw new ValidationError(`Câu "${q.label}": ${msg}`); };

    switch (q.type) {
      case 'short_text':
      case 'long_text': {
        const text = str(v);
        if (text.length > LIMITS.text) fail('nội dung quá dài');
        if (q.type === 'short_text' && s.inputKind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) fail('email không hợp lệ');
        if (q.type === 'short_text' && s.inputKind === 'phone' && !/^[0-9+().\s-]{8,20}$/.test(text)) fail('số điện thoại không hợp lệ');
        row.valueText = text;
        row.valueDisplay = text;
        break;
      }
      case 'number':
      case 'currency': {
        const n = Number(v);
        if (!isFiniteNum(n)) fail('phải là số');
        if (s.min !== undefined && n < s.min) fail(`nhỏ nhất là ${fmtNumber(s.min)}`);
        if (s.max !== undefined && n > s.max) fail(`lớn nhất là ${fmtNumber(s.max)}`);
        if (Math.abs(n) >= 1e16) fail('số quá lớn');
        row.valueNumber = Math.round(n * 100) / 100;
        row.valueDisplay = fmtNumber(row.valueNumber) + (s.unit ? ` ${s.unit}` : '');
        break;
      }
      case 'linear_scale':
      case 'rating': {
        const n = Number(v);
        const min = q.type === 'rating' ? 1 : s.min ?? 1;
        const max = s.max ?? 5;
        if (!Number.isInteger(n) || n < min || n > max) fail(`chọn từ ${min} đến ${max}`);
        row.valueNumber = n;
        row.valueDisplay = q.type === 'rating' ? `${n}/${max} sao` : `${n}/${max}`;
        break;
      }
      case 'yes_no': {
        const t = str(v);
        if (t !== 'yes' && t !== 'no') fail('chỉ chọn Có hoặc Không');
        row.valueText = t;
        row.valueDisplay = t === 'yes' ? s.yesLabel || 'Có' : s.noLabel || 'Không';
        break;
      }
      case 'date': {
        const t = str(v);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) fail('ngày không hợp lệ');
        row.valueText = t;
        const [y, m, d] = t.split('-');
        row.valueDisplay = `${d}/${m}/${y}`;
        break;
      }
      case 'single_choice':
      case 'dropdown': {
        const id = str(v.optionId);
        const opts = s.options || [];
        if (id === OTHER_ID) {
          if (!s.allowOther) fail('không cho phép chọn "Khác"');
          const other = str(v.otherText);
          if (!other) fail('chưa ghi rõ lựa chọn "Khác"');
          if (other.length > LIMITS.optionLabel) fail('nội dung "Khác" quá dài');
          row.valueText = OTHER_ID;
          row.valueJson = JSON.stringify({ other });
          row.valueDisplay = `Khác: ${other}`;
        } else {
          const opt = opts.find((o) => o.id === id);
          if (!opt) fail('lựa chọn không hợp lệ');
          row.valueText = opt.id;
          row.valueDisplay = opt.label;
        }
        break;
      }
      case 'multiple_choice': {
        const ids = [...new Set(v.optionIds.map((x) => str(x)).filter(Boolean))];
        const opts = s.options || [];
        const labels = [];
        let other = null;
        for (const id of ids) {
          if (id === OTHER_ID) {
            if (!s.allowOther) fail('không cho phép chọn "Khác"');
            other = str(v.otherText);
            if (!other) fail('chưa ghi rõ lựa chọn "Khác"');
            if (other.length > LIMITS.optionLabel) fail('nội dung "Khác" quá dài');
          } else {
            const opt = opts.find((o) => o.id === id);
            if (!opt) fail('lựa chọn không hợp lệ');
            labels.push(opt.label);
          }
        }
        if (s.maxSelect && ids.length > s.maxSelect) fail(`chọn tối đa ${s.maxSelect}`);
        row.valueJson = JSON.stringify(other ? { ids, other } : { ids });
        row.valueDisplay = [...labels, ...(other ? [`Khác: ${other}`] : [])].join('; ');
        break;
      }
      default:
        fail('loại câu hỏi không hỗ trợ');
    }
    rows.push(row);
  }

  if (missing.length) {
    const list = missing.slice(0, 5).map((l) => `"${l}"`).join(', ');
    throw new ValidationError(`Chưa trả lời câu bắt buộc: ${list}${missing.length > 5 ? '…' : ''}`);
  }
  return rows;
}

/** Chuyển câu trả lời đã lưu về dạng raw để frontend nạp lại khi sửa phiếu */
function answerRowToRaw(type, row) {
  let json = null;
  try { json = row.valueJson ? JSON.parse(row.valueJson) : null; } catch { json = null; }
  if (type === 'multiple_choice') return { optionIds: json?.ids || [], otherText: json?.other || '' };
  if (type === 'single_choice' || type === 'dropdown') return { optionId: row.valueText || '', otherText: json?.other || '' };
  if (NUMERIC_TYPES.includes(type)) return row.valueNumber === null ? null : Number(row.valueNumber);
  return row.valueText ?? null;
}

function parseSettings(text) {
  if (!text) return {};
  try { return JSON.parse(text) || {}; } catch { return {}; }
}

module.exports = {
  QUESTION_TYPES,
  CHOICE_TYPES,
  NUMERIC_TYPES,
  OTHER_ID,
  ValidationError,
  normalizeDefinition,
  normalizeLocalDateTime,
  visibleQuestionKeys,
  buildAnswerRows,
  answerRowToRaw,
  parseSettings,
};
