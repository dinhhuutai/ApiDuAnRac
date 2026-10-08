// RequestManagement/requests.js — đề xuất: danh sách, chi tiết, gửi, duyệt, bình luận, thông báo
// Mount trong RequestManagement/index.js (prefix /api/rq).
const express = require('express');
const { sql, poolPromise } = require('../db');
const C = require('./common');
const D = require('./definition');
const F = require('./files');
const { notify, later } = require('./notify');

const router = express.Router();
const { moduleUser, dt, parseId, handleError, httpError, ok, canViewExpr, isAdmin, getProfile, activeUserIds, profileApply } = C;

const num = (v) => (v === null || v === undefined ? null : Number(v));
const str = (v, max) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const STATUSES = ['pending', 'approved', 'rejected', 'returned', 'cancelled'];

/* ================================ DANH BẠ ================================ */
// Danh sách người dùng module 18 + phòng ban + tổ — frontend tải 1 lần, dùng cho ô chọn người,
// @nhắc tên, chat, hiển thị tên/ảnh. Nhớ 60 giây ở server (server yếu, ~320 người).
let dirCache = { at: 0, data: null };

async function loadDirectory(pool) {
  if (dirCache.data && Date.now() - dirCache.at < 60000) return dirCache.data;
  const r = await pool.request().query(`
    SELECT u.userID AS id, u.fullName AS name, u.msnv, u.avatar, p.departmentId AS d, p.teamId AS t, j.name AS j
    FROM dbo.Users u
    JOIN dbo.UserModules um ON um.userId = u.userID AND um.moduleId = ${C.MODULE_ID}
    ${profileApply('u')}
    LEFT JOIN dbo.org_JobTitles j ON j.jobTitleId = p.jobTitleId
    WHERE u.isDeleted = 0 AND ISNULL(u.isActive, 0) = 1
    ORDER BY u.fullName;
    SELECT departmentId AS id, name, code FROM dbo.org_Departments WHERE isActive = 1 ORDER BY sortOrder, name;
    SELECT teamId AS id, name, code, departmentId FROM dbo.org_Teams WHERE isActive = 1 ORDER BY sortOrder, name;`);
  const data = { users: r.recordsets[0], departments: r.recordsets[1], teams: r.recordsets[2] };
  dirCache = { at: Date.now(), data };
  return data;
}
const clearDirectoryCache = () => { dirCache = { at: 0, data: null }; };

router.get('/directory', moduleUser, async (req, res) => {
  try {
    ok(req, res, await loadDirectory(await poolPromise));
  } catch (err) { handleError(res, err, 'GET /directory'); }
});

/* ================================ CON SỐ / KHỞI ĐỘNG ================================ */

async function pulse(pool, uid) {
  const r = await pool.request().input('uid', sql.Int, uid).query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.rq_RequestApprovers a
         JOIN dbo.rq_Requests r ON r.requestId = a.requestId
        WHERE a.userId = @uid AND a.status = N'pending' AND r.status = N'pending' AND r.isDeleted = 0) AS inbox,
      (SELECT COUNT(*) FROM dbo.rq_Requests WHERE requesterId = @uid AND status = N'returned' AND isDeleted = 0) AS returned,
      (SELECT COUNT(*) FROM dbo.rq_Requests WHERE requesterId = @uid AND status = N'pending' AND isDeleted = 0) AS minePending,
      (SELECT COUNT(*) FROM dbo.rq_Notifications WHERE userId = @uid AND isRead = 0) AS unreadNotifications,
      (SELECT ISNULL(MAX(notificationId), 0) FROM dbo.rq_Notifications WHERE userId = @uid) AS lastNotificationId,
      (SELECT COUNT(*) FROM dbo.rq_ConversationMembers m
         JOIN dbo.rq_Messages x ON x.conversationId = m.conversationId AND x.messageId > m.lastReadMessageId
        WHERE m.userId = @uid AND x.userId <> @uid AND x.isDeleted = 0) AS unreadChat`);
  const p = r.recordset[0] || {};
  return {
    inbox: p.inbox || 0,
    returned: p.returned || 0,
    minePending: p.minePending || 0,
    unreadNotifications: p.unreadNotifications || 0,
    lastNotificationId: num(p.lastNotificationId) || 0,
    unreadChat: p.unreadChat || 0,
  };
}

// Gọi định kỳ (30 giây, chỉ khi tab đang mở) để cập nhật huy hiệu
router.get('/me/pulse', moduleUser, async (req, res) => {
  try {
    ok(req, res, await pulse(await poolPromise, req.user.userID));
  } catch (err) { handleError(res, err, 'GET /me/pulse'); }
});

function typeOut(t, { full = true } = {}) {
  const out = {
    typeId: t.typeId,
    groupId: t.groupId,
    name: t.name,
    description: t.description,
    icon: t.icon,
    color: t.color,
    sortOrder: t.sortOrder,
  };
  if (full) {
    out.fields = D.parseJson(t.fields, []);
    out.flow = D.parseJson(t.flow, []);
    out.defaultFollowers = D.parseJson(t.defaultFollowers, []);
    out.options = D.normalizeOptions(D.parseJson(t.options, {}));
  }
  return out;
}

// 1 lần gọi khi mở module: hồ sơ, vai trò, nhóm + mẫu được gửi, con số, cấu hình máy chủ tệp
router.get('/me/bootstrap', moduleUser, async (req, res) => {
  try {
    const pool = await poolPromise;
    const uid = req.user.userID;
    const [profile, r, counts] = await Promise.all([
      getProfile(pool, uid),
      pool.request().input('uid', sql.Int, uid).query(`
        SELECT groupId, name, color, sortOrder FROM dbo.rq_Groups WHERE isActive = 1 ORDER BY sortOrder, name;
        SELECT typeId, groupId, name, description, icon, color, fields, flow, audience, defaultFollowers, options, sortOrder
        FROM dbo.rq_Types WHERE isDeleted = 0 AND isActive = 1 ORDER BY sortOrder, name;`),
      pulse(pool, uid),
    ]);
    const heads = await pool.request()
      .input('dept', sql.Int, profile?.departmentId || null)
      .input('team', sql.Int, profile?.teamId || null)
      .query(`
        SELECT h.scopeType, h.userId FROM dbo.rq_OrgHeads h
        JOIN dbo.Users u ON u.userID = h.userId AND u.isDeleted = 0 AND ISNULL(u.isActive, 0) = 1
        WHERE (h.scopeType = N'department' AND h.scopeId = @dept) OR (h.scopeType = N'team' AND h.scopeId = @team)`);
    const types = r.recordsets[1]
      .filter((t) => D.audienceAllows(t.audience, uid, profile))
      .map((t) => typeOut(t));
    ok(req, res, {
      me: { ...profile, role: req.moduleRole, isAdmin: isAdmin(req) },
      myHeads: {
        department: heads.recordset.filter((h) => h.scopeType === 'department').map((h) => h.userId),
        team: heads.recordset.filter((h) => h.scopeType === 'team').map((h) => h.userId),
      },
      groups: r.recordsets[0],
      types,
      counts,
      files: F.clientConfig(),
      pushPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    });
  } catch (err) { handleError(res, err, 'GET /me/bootstrap'); }
});

/* ================================ TỆP ================================ */

// Vé tải lên máy chủ tệp nội bộ (trình duyệt tải thẳng lên, không qua API này)
router.post('/files/ticket', moduleUser, async (req, res) => {
  try {
    if (!F.enabled()) throw httpError(409, 'Chưa cấu hình máy chủ tệp nội bộ — liên hệ IT (xem fileserver/README.md)');
    ok(req, res, { ...F.clientConfig(), ticket: F.uploadTicket(req.user.userID, 'rq') });
  } catch (err) { handleError(res, err, 'POST /files/ticket'); }
});

/* ================================ DANH SÁCH ================================ */

const BOX_COND = {
  inbox: `r.status = N'pending' AND EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers a WHERE a.requestId = r.requestId AND a.userId = @uid AND a.status = N'pending')`,
  processed: `EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers a WHERE a.requestId = r.requestId AND a.userId = @uid AND a.status IN (N'approved', N'rejected', N'returned'))`,
  mine: `r.requesterId = @uid`,
  following: `EXISTS (SELECT 1 FROM dbo.rq_RequestFollowers f WHERE f.requestId = r.requestId AND f.userId = @uid)`,
  all: canViewExpr('r'),
};

router.get('/requests', moduleUser, async (req, res) => {
  try {
    const box = Object.prototype.hasOwnProperty.call(BOX_COND, req.query.box) ? req.query.box : 'all';
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
    let q = str(req.query.q, 100);
    const idMatch = /^#?(\d{1,9})$/.exec(q);
    const pool = await poolPromise;
    const r = await pool.request()
      .input('uid', sql.Int, req.user.userID)
      .input('isAdmin', sql.Bit, isAdmin(req))
      .input('status', sql.NVarChar(20), status)
      .input('typeId', sql.Int, parseId(req.query.typeId))
      .input('groupId', sql.Int, parseId(req.query.groupId))
      .input('dept', sql.Int, parseId(req.query.departmentId))
      .input('team', sql.Int, parseId(req.query.teamId))
      .input('requester', sql.Int, parseId(req.query.requesterId))
      .input('q', sql.NVarChar(100), q)
      .input('qId', sql.Int, idMatch ? Number(idMatch[1]) : null)
      .input('from', sql.VarChar(10), D.isValidDate(req.query.from) ? req.query.from : null)
      .input('to', sql.VarChar(10), D.isValidDate(req.query.to) ? req.query.to : null)
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('fetch', sql.Int, pageSize)
      .query(`
        SELECT r.requestId, r.title, r.typeId, r.typeName, t.icon, t.color, r.groupId,
               r.requesterId, r.requesterName, r.departmentId, r.departmentName, r.teamName,
               r.status, r.priority, CONVERT(varchar(10), r.deadline, 23) AS deadline,
               r.currentStep, r.stepCount, r.commentCount, r.fileCount,
               ${dt('r.createdAt', 'createdAt')}, ${dt('r.lastActivityAt', 'lastActivityAt')}, ${dt('r.finishedAt', 'finishedAt')},
               (SELECT STRING_AGG(CAST(a.userId AS NVARCHAR(12)), N',') FROM dbo.rq_RequestApprovers a
                 WHERE a.requestId = r.requestId AND a.status = N'pending') AS waitingIds,
               CAST(CASE WHEN r.status = N'pending' AND EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers a
                 WHERE a.requestId = r.requestId AND a.userId = @uid AND a.status = N'pending') THEN 1 ELSE 0 END AS bit) AS myTurn,
               COUNT(*) OVER () AS total
        FROM dbo.rq_Requests r
        LEFT JOIN dbo.rq_Types t ON t.typeId = r.typeId
        WHERE r.isDeleted = 0 AND ${BOX_COND[box]}
          AND (@status IS NULL OR r.status = @status)
          AND (@typeId IS NULL OR r.typeId = @typeId)
          AND (@groupId IS NULL OR r.groupId = @groupId)
          AND (@dept IS NULL OR r.departmentId = @dept)
          AND (@team IS NULL OR r.teamId = @team)
          AND (@requester IS NULL OR r.requesterId = @requester)
          AND (@q = N'' OR r.requestId = @qId
               OR r.title COLLATE Latin1_General_CI_AI LIKE N'%' + @q + N'%' COLLATE Latin1_General_CI_AI
               OR r.requesterName COLLATE Latin1_General_CI_AI LIKE N'%' + @q + N'%' COLLATE Latin1_General_CI_AI
               OR r.typeName COLLATE Latin1_General_CI_AI LIKE N'%' + @q + N'%' COLLATE Latin1_General_CI_AI)
          AND (@from IS NULL OR r.createdAt >= CONVERT(date, @from, 23))
          AND (@to IS NULL OR r.createdAt < DATEADD(day, 1, CONVERT(date, @to, 23)))
        ORDER BY ${box === 'inbox' ? "CASE WHEN r.priority = N'high' THEN 0 ELSE 1 END, " : ''}r.lastActivityAt DESC, r.requestId DESC
        OFFSET @offset ROWS FETCH NEXT @fetch ROWS ONLY`);
    const rows = r.recordset.map(({ total, waitingIds, ...x }) => ({
      ...x,
      waitingIds: waitingIds ? waitingIds.split(',').map(Number) : [],
    }));
    ok(req, res, { box, page, pageSize, total: r.recordset[0]?.total || 0, rows });
  } catch (err) { handleError(res, err, 'GET /requests'); }
});

/* ================================ CHI TIẾT ================================ */

const FILE_COLS = `f.fileId, f.storageKey, f.fileName, f.mimeType, f.sizeBytes, f.hasThumb, f.width, f.height,
  f.ownerType, f.ownerId, f.fieldKey, f.uploadedBy, ${dt('f.createdAt', 'createdAt')}`;

const commentOut = (c, filesByComment) => ({
  commentId: num(c.commentId),
  parentId: num(c.parentId),
  userId: c.userId,
  fullName: c.fullName,
  body: c.isDeleted ? null : c.body,
  isDeleted: !!c.isDeleted,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  files: c.isDeleted ? [] : filesByComment.get(num(c.commentId)) || [],
});

function groupCommentFiles(files) {
  const m = new Map();
  for (const f of files) {
    if (f.ownerType !== 'comment') continue;
    const k = num(f.ownerId);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(F.fileOut(f));
  }
  return m;
}

async function loadDetail(pool, rid, uid, admin) {
  const r = await pool.request()
    .input('rid', sql.Int, rid).input('uid', sql.Int, uid).input('isAdmin', sql.Bit, admin)
    .query(`
      DECLARE @ok BIT = CASE WHEN EXISTS (SELECT 1 FROM dbo.rq_Requests r WHERE r.requestId = @rid AND r.isDeleted = 0 AND ${canViewExpr('r')}) THEN 1 ELSE 0 END;

      SELECT r.requestId, r.typeId, r.typeName, t.icon, t.color, t.options AS typeOptions, r.groupId, r.title,
             r.requesterId, r.requesterName, r.msnv, r.departmentId, r.departmentName, r.teamId, r.teamName, r.jobTitleName,
             r.fields, r.fieldValues, r.flow, r.status, r.priority, CONVERT(varchar(10), r.deadline, 23) AS deadline,
             r.currentStep, r.stepCount, r.commentCount, r.fileCount, r.editCount,
             ${dt('r.createdAt', 'createdAt')}, ${dt('r.updatedAt', 'updatedAt')}, ${dt('r.finishedAt', 'finishedAt')},
             ${dt('r.lastActivityAt', 'lastActivityAt')}
      FROM dbo.rq_Requests r LEFT JOIN dbo.rq_Types t ON t.typeId = r.typeId
      WHERE @ok = 1 AND r.requestId = @rid;

      SELECT a.id, a.stepNo, a.stepName, a.stepMode, a.userId, u.fullName, a.status, a.note, ${dt('a.actedAt', 'actedAt')}
      FROM dbo.rq_RequestApprovers a JOIN dbo.Users u ON u.userID = a.userId
      WHERE @ok = 1 AND a.requestId = @rid ORDER BY a.stepNo, a.id;

      SELECT f.userId, u.fullName, f.addedBy, ${dt('f.createdAt', 'createdAt')}
      FROM dbo.rq_RequestFollowers f JOIN dbo.Users u ON u.userID = f.userId
      WHERE @ok = 1 AND f.requestId = @rid ORDER BY f.createdAt;

      SELECT ${FILE_COLS} FROM dbo.rq_Files f WHERE @ok = 1 AND f.requestId = @rid ORDER BY f.fileId;

      SELECT c.commentId, c.parentId, c.userId, u.fullName, c.body, c.isDeleted,
             ${dt('c.createdAt', 'createdAt')}, ${dt('c.updatedAt', 'updatedAt')}
      FROM dbo.rq_Comments c JOIN dbo.Users u ON u.userID = c.userId
      WHERE @ok = 1 AND c.requestId = @rid ORDER BY c.commentId;

      SELECT a.activityId, a.userId, u.fullName, a.action, a.stepNo, a.note, ${dt('a.createdAt', 'createdAt')}
      FROM dbo.rq_Activities a LEFT JOIN dbo.Users u ON u.userID = a.userId
      WHERE @ok = 1 AND a.requestId = @rid ORDER BY a.activityId;`);

  const req0 = r.recordsets[0][0];
  if (!req0) return null;
  const approvers = r.recordsets[1];
  const followers = r.recordsets[2];
  const files = r.recordsets[3];
  const filesByComment = groupCommentFiles(files);
  const options = D.normalizeOptions(D.parseJson(req0.typeOptions, {}));
  const { typeOptions, fields, fieldValues, flow, ...base } = req0;

  const isRequester = req0.requesterId === uid;
  const isApprover = approvers.some((a) => a.userId === uid);
  const myTurn = req0.status === 'pending' && approvers.some((a) => a.userId === uid && a.status === 'pending');
  const untouched = approvers.every((a) => a.status === 'waiting' || a.status === 'pending');

  return {
    ...base,
    fields: D.parseJson(fields, []),
    values: D.parseJson(fieldValues, {}),
    flow: D.parseJson(flow, []),
    options,
    approvers,
    followers,
    files: files.filter((f) => f.ownerType === 'request').map(F.fileOut),
    comments: r.recordsets[4].map((c) => commentOut(c, filesByComment)),
    activities: r.recordsets[5].map((a) => ({ ...a, activityId: num(a.activityId) })),
    permissions: {
      approve: myTurn,
      cancel: isRequester && ['pending', 'returned'].includes(req0.status),
      edit: isRequester && (req0.status === 'returned' || (req0.status === 'pending' && untouched)),
      addFollower: options.allowFollowers && (isRequester || isApprover || admin),
      comment: true,
    },
    my: { isRequester, isApprover, myTurn, isFollower: followers.some((f) => f.userId === uid) },
  };
}

router.get('/requests/:id', moduleUser, async (req, res) => {
  try {
    const rid = parseId(req.params.id);
    if (!rid) return res.status(400).json({ success: false, message: 'Mã đề xuất không hợp lệ' });
    const detail = await loadDetail(await poolPromise, rid, req.user.userID, isAdmin(req));
    if (!detail) return res.status(404).json({ success: false, message: 'Không tìm thấy đề xuất hoặc bạn không được xem' });
    ok(req, res, detail);
  } catch (err) { handleError(res, err, 'GET /requests/:id'); }
});

// Polling nhẹ khi đang mở chi tiết: bình luận mới + trạng thái (đổi thì frontend tải lại chi tiết)
router.get('/requests/:id/updates', moduleUser, async (req, res) => {
  try {
    const rid = parseId(req.params.id);
    if (!rid) return res.status(400).json({ success: false, message: 'Mã đề xuất không hợp lệ' });
    const after = Math.max(0, Number(req.query.afterCommentId) || 0);
    const pool = await poolPromise;
    const r = await pool.request()
      .input('rid', sql.Int, rid).input('uid', sql.Int, req.user.userID).input('isAdmin', sql.Bit, isAdmin(req))
      .input('after', sql.BigInt, after)
      .query(`
        DECLARE @ok BIT = CASE WHEN EXISTS (SELECT 1 FROM dbo.rq_Requests r WHERE r.requestId = @rid AND r.isDeleted = 0 AND ${canViewExpr('r')}) THEN 1 ELSE 0 END;
        SELECT r.status, r.commentCount, ${dt('r.lastActivityAt', 'lastActivityAt')} FROM dbo.rq_Requests r WHERE @ok = 1 AND r.requestId = @rid;
        SELECT c.commentId, c.parentId, c.userId, u.fullName, c.body, c.isDeleted, ${dt('c.createdAt', 'createdAt')}, ${dt('c.updatedAt', 'updatedAt')}
        FROM dbo.rq_Comments c JOIN dbo.Users u ON u.userID = c.userId
        WHERE @ok = 1 AND c.requestId = @rid AND c.commentId > @after ORDER BY c.commentId;
        SELECT ${FILE_COLS} FROM dbo.rq_Files f
        WHERE @ok = 1 AND f.ownerType = N'comment' AND f.requestId = @rid
          AND f.ownerId > @after;`);
    const head = r.recordsets[0][0];
    if (!head) return res.status(404).json({ success: false, message: 'Không tìm thấy đề xuất' });
    const filesByComment = groupCommentFiles(r.recordsets[2]);
    ok(req, res, { ...head, comments: r.recordsets[1].map((c) => commentOut(c, filesByComment)) });
  } catch (err) { handleError(res, err, 'GET /requests/:id/updates'); }
});

/* ================================ GỬI ĐỀ XUẤT ================================ */

const APPROVER_JSON = `OPENJSON(@approvers) WITH (stepNo INT '$.stepNo', stepName NVARCHAR(150) '$.stepName',
  stepMode NVARCHAR(5) '$.stepMode', userId INT '$.userId', status NVARCHAR(10) '$.status') j`;
const FILES_JSON = `OPENJSON(@files) WITH ([key] NVARCHAR(200) '$.key', name NVARCHAR(255) '$.name', mime NVARCHAR(150) '$.mime',
  size BIGINT '$.size', hasThumb BIT '$.hasThumb', width INT '$.width', height INT '$.height', fieldKey NVARCHAR(40) '$.fieldKey') j`;

/** Tệp + giá trị trường: chỉ giữ fieldKey trỏ tới trường loại 'files' */
function prepareFilesAndValues(fields, rawValues, files) {
  const fileFieldKeys = new Set(fields.filter((f) => f.type === 'files').map((f) => f.key));
  for (const f of files) if (f.fieldKey && !fileFieldKeys.has(f.fieldKey)) f.fieldKey = null;
  const countByField = {};
  for (const f of files) if (f.fieldKey) countByField[f.fieldKey] = (countByField[f.fieldKey] || 0) + 1;
  return D.buildValues(fields, rawValues, countByField);
}

router.post('/requests', moduleUser, async (req, res) => {
  try {
    const b = req.body || {};
    const uid = req.user.userID;
    const typeId = parseId(b.typeId);
    if (!typeId) throw new D.ValidationError('Chưa chọn mẫu đề xuất');
    const pool = await poolPromise;

    const t = (await pool.request().input('tid', sql.Int, typeId).query(`
      SELECT typeId, groupId, name, fields, flow, audience, defaultFollowers, options
      FROM dbo.rq_Types WHERE typeId = @tid AND isDeleted = 0 AND isActive = 1`)).recordset[0];
    if (!t) throw httpError(404, 'Mẫu đề xuất không tồn tại hoặc đã ngừng dùng');
    const profile = await getProfile(pool, uid);
    if (!D.audienceAllows(t.audience, uid, profile)) throw httpError(403, 'Bạn không được gửi mẫu đề xuất này');

    const fields = D.parseJson(t.fields, []);
    const flow = D.parseJson(t.flow, []);
    const options = D.normalizeOptions(D.parseJson(t.options, {}));

    const files = F.readAttachments(b.attachments, uid, { max: 50, allowFieldKey: true });
    const { values, userIds: valueUserIds } = prepareFilesAndValues(fields, b.values, files);
    if (options.requireAttachment && !files.length) throw new D.ValidationError('Mẫu này bắt buộc đính kèm tệp');

    const title = str(b.title, 300) || `${t.name} - ${profile?.fullName || ''}`.slice(0, 300);
    const priority = options.allowPriority && b.priority === 'high' ? 'high' : 'normal';
    const deadline = options.allowDeadline && D.isValidDate(b.deadline) ? b.deadline : null;
    const picked = b.pickedApprovers && typeof b.pickedApprovers === 'object' ? b.pickedApprovers : {};
    const defaultFollowers = D.ids(D.parseJson(t.defaultFollowers, []), 50);
    const extraFollowers = options.allowFollowers ? D.ids(b.followerIds, 50) : [];

    const heads = (await pool.request()
      .input('dept', sql.Int, profile?.departmentId || null)
      .input('team', sql.Int, profile?.teamId || null)
      .query(`SELECT scopeType, userId FROM dbo.rq_OrgHeads
              WHERE (scopeType = N'department' AND scopeId = @dept) OR (scopeType = N'team' AND scopeId = @team)`)).recordset;
    const deptHeads = heads.filter((h) => h.scopeType === 'department').map((h) => h.userId);
    const teamHeads = heads.filter((h) => h.scopeType === 'team').map((h) => h.userId);

    const active = await activeUserIds(pool, [
      ...D.flowUserIds(flow, picked), ...deptHeads, ...teamHeads, ...defaultFollowers, ...extraFollowers, ...valueUserIds,
    ]);
    if (valueUserIds.some((id) => !active.has(id))) throw new D.ValidationError('Có người được chọn trong đề xuất không còn hoạt động');

    const { steps, skipped } = D.resolveFlow(flow, {
      requesterId: uid, deptHeads, teamHeads, picked, activeIds: active,
      hasDept: !!profile?.departmentId, hasTeam: !!profile?.teamId,
    });
    const approverRows = steps.flatMap((s) => s.userIds.map((userId) => ({
      stepNo: s.stepNo, stepName: s.name, stepMode: s.mode, userId, status: s.stepNo === 1 ? 'pending' : 'waiting',
    })));
    const approverSet = new Set(approverRows.map((a) => a.userId));
    const followers = [...new Set([...defaultFollowers, ...extraFollowers])]
      .filter((id) => active.has(id) && id !== uid && !approverSet.has(id));
    const status = steps.length ? 'pending' : 'approved';
    const note = skipped.length ? `Bỏ qua bước: ${skipped.join(', ')} (người gửi là người duyệt)` : null;

    const r = await pool.request()
      .input('uid', sql.Int, uid)
      .input('typeId', sql.Int, t.typeId)
      .input('typeName', sql.NVarChar(200), t.name)
      .input('groupId', sql.Int, t.groupId)
      .input('title', sql.NVarChar(300), title)
      .input('name', sql.NVarChar(200), profile?.fullName || null)
      .input('msnv', sql.NVarChar(50), profile?.msnv || null)
      .input('deptId', sql.Int, profile?.departmentId || null)
      .input('deptName', sql.NVarChar(150), profile?.departmentName || null)
      .input('teamId', sql.Int, profile?.teamId || null)
      .input('teamName', sql.NVarChar(150), profile?.teamName || null)
      .input('titleName', sql.NVarChar(150), profile?.jobTitleName || null)
      .input('fields', sql.NVarChar(sql.MAX), JSON.stringify(fields))
      .input('values', sql.NVarChar(sql.MAX), JSON.stringify(values))
      .input('flow', sql.NVarChar(sql.MAX), JSON.stringify(flow))
      .input('status', sql.NVarChar(20), status)
      .input('priority', sql.NVarChar(10), priority)
      .input('deadline', sql.VarChar(10), deadline)
      .input('stepCount', sql.Int, steps.length)
      .input('approvers', sql.NVarChar(sql.MAX), JSON.stringify(approverRows))
      .input('followers', sql.NVarChar(sql.MAX), JSON.stringify(followers))
      .input('files', sql.NVarChar(sql.MAX), JSON.stringify(files))
      .input('fileCount', sql.Int, files.length)
      .input('note', sql.NVarChar(1000), note)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @rid INT;
        INSERT INTO dbo.rq_Requests (typeId, typeName, groupId, title, requesterId, requesterName, msnv,
          departmentId, departmentName, teamId, teamName, jobTitleName, fields, fieldValues, flow,
          status, priority, deadline, currentStep, stepCount, fileCount, finishedAt)
        VALUES (@typeId, @typeName, @groupId, @title, @uid, @name, @msnv,
          @deptId, @deptName, @teamId, @teamName, @titleName, @fields, @values, @flow,
          @status, @priority, CONVERT(date, @deadline, 23), 1, @stepCount, @fileCount,
          CASE WHEN @status = N'approved' THEN SYSDATETIME() END);
        SET @rid = SCOPE_IDENTITY();

        INSERT INTO dbo.rq_RequestApprovers (requestId, stepNo, stepName, stepMode, userId, status)
        SELECT @rid, j.stepNo, j.stepName, j.stepMode, j.userId, j.status FROM ${APPROVER_JSON};

        INSERT INTO dbo.rq_RequestFollowers (requestId, userId, addedBy)
        SELECT @rid, CAST([value] AS INT), @uid FROM OPENJSON(@followers);

        INSERT INTO dbo.rq_Files (storageKey, fileName, mimeType, sizeBytes, hasThumb, width, height,
          ownerType, ownerId, requestId, fieldKey, uploadedBy)
        SELECT j.[key], j.name, j.mime, j.size, ISNULL(j.hasThumb, 0), j.width, j.height,
          N'request', @rid, @rid, j.fieldKey, @uid FROM ${FILES_JSON};

        INSERT INTO dbo.rq_Activities (requestId, userId, action, note) VALUES (@rid, @uid, N'create', @note);
        IF @status = N'approved'
          INSERT INTO dbo.rq_Activities (requestId, userId, action, note)
          VALUES (@rid, NULL, N'approve', N'Tự duyệt: không còn bước nào cần người khác duyệt');
        COMMIT;
        SELECT @rid AS requestId;`);

    const requestId = r.recordset[0].requestId;
    ok(req, res, { requestId, status });

    later(async () => {
      const who = profile?.fullName || 'Một nhân viên';
      const first = approverRows.filter((a) => a.stepNo === 1).map((a) => a.userId);
      await notify({ userIds: first, actorId: uid, type: 'approval', requestId, title: `${who} gửi đề xuất cần bạn duyệt`, body: `${t.name}: ${title}` });
      await notify({ userIds: followers, actorId: uid, type: 'follow', requestId, title: `${who} thêm bạn theo dõi đề xuất`, body: `${t.name}: ${title}`, push: false });
    });
  } catch (err) { handleError(res, err, 'POST /requests'); }
});

// Sửa & gửi lại (khi bị trả lại, hoặc khi chưa ai xử lý)
router.put('/requests/:id', moduleUser, async (req, res) => {
  try {
    const rid = parseId(req.params.id);
    if (!rid) return res.status(400).json({ success: false, message: 'Mã đề xuất không hợp lệ' });
    const uid = req.user.userID;
    const b = req.body || {};
    const pool = await poolPromise;
    const cur = (await pool.request().input('rid', sql.Int, rid).query(`
      SELECT r.requestId, r.requesterId, r.status, r.title, r.typeName, r.fields, t.options
      FROM dbo.rq_Requests r LEFT JOIN dbo.rq_Types t ON t.typeId = r.typeId
      WHERE r.requestId = @rid AND r.isDeleted = 0`)).recordset[0];
    if (!cur) throw httpError(404, 'Không tìm thấy đề xuất');
    if (cur.requesterId !== uid) throw httpError(403, 'Chỉ người gửi được sửa đề xuất');
    const fields = D.parseJson(cur.fields, []);
    const options = D.normalizeOptions(D.parseJson(cur.options, {}));

    const keepIds = D.ids(b.keepFileIds, 200);
    const newFiles = F.readAttachments(b.attachments, uid, { max: 50, allowFieldKey: true });
    const kept = keepIds.length ? (await pool.request()
      .input('rid', sql.Int, rid).input('ids', sql.NVarChar(sql.MAX), JSON.stringify(keepIds))
      .query(`SELECT fileId, fieldKey FROM dbo.rq_Files WHERE ownerType = N'request' AND ownerId = @rid
              AND fileId IN (SELECT CAST([value] AS BIGINT) FROM OPENJSON(@ids))`)).recordset : [];
    const { values, userIds: valueUserIds } = prepareFilesAndValues(fields, b.values, [...kept.map((k) => ({ fieldKey: k.fieldKey })), ...newFiles]);
    if (options.requireAttachment && !kept.length && !newFiles.length) throw new D.ValidationError('Mẫu này bắt buộc đính kèm tệp');
    if (valueUserIds.length) {
      const active = await activeUserIds(pool, valueUserIds);
      if (valueUserIds.some((id) => !active.has(id))) throw new D.ValidationError('Có người được chọn trong đề xuất không còn hoạt động');
    }

    const r = await pool.request()
      .input('rid', sql.Int, rid).input('uid', sql.Int, uid)
      .input('title', sql.NVarChar(300), str(b.title, 300) || cur.title)
      .input('values', sql.NVarChar(sql.MAX), JSON.stringify(values))
      .input('priority', sql.NVarChar(10), options.allowPriority && b.priority === 'high' ? 'high' : 'normal')
      .input('deadline', sql.VarChar(10), options.allowDeadline && D.isValidDate(b.deadline) ? b.deadline : null)
      .input('keep', sql.NVarChar(sql.MAX), JSON.stringify(kept.map((k) => num(k.fileId))))
      .input('files', sql.NVarChar(sql.MAX), JSON.stringify(newFiles))
      .input('note', sql.NVarChar(1000), str(b.note, 1000) || null)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @status NVARCHAR(20), @requester INT;
        SELECT @status = status, @requester = requesterId FROM dbo.rq_Requests WITH (UPDLOCK, HOLDLOCK)
        WHERE requestId = @rid AND isDeleted = 0;
        IF @requester IS NULL OR @requester <> @uid THROW 50050, N'Không tìm thấy đề xuất của bạn', 1;
        IF @status NOT IN (N'returned', N'pending') THROW 50051, N'Đề xuất đã kết thúc, không sửa được', 1;
        IF @status = N'pending' AND EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers WHERE requestId = @rid AND status NOT IN (N'waiting', N'pending'))
          THROW 50052, N'Đã có người xử lý đề xuất — không sửa được nữa. Hãy bình luận để bổ sung thông tin.', 1;

        DELETE FROM dbo.rq_Files WHERE ownerType = N'request' AND ownerId = @rid
          AND fileId NOT IN (SELECT CAST([value] AS BIGINT) FROM OPENJSON(@keep));
        INSERT INTO dbo.rq_Files (storageKey, fileName, mimeType, sizeBytes, hasThumb, width, height,
          ownerType, ownerId, requestId, fieldKey, uploadedBy)
        SELECT j.[key], j.name, j.mime, j.size, ISNULL(j.hasThumb, 0), j.width, j.height,
          N'request', @rid, @rid, j.fieldKey, @uid FROM ${FILES_JSON};

        UPDATE dbo.rq_RequestApprovers
        SET status = CASE WHEN stepNo = 1 THEN N'pending' ELSE N'waiting' END, note = NULL, actedAt = NULL
        WHERE requestId = @rid;

        UPDATE dbo.rq_Requests
        SET title = @title, fieldValues = @values, priority = @priority, deadline = CONVERT(date, @deadline, 23),
            status = CASE WHEN stepCount = 0 THEN N'approved' ELSE N'pending' END, currentStep = 1,
            finishedAt = CASE WHEN stepCount = 0 THEN SYSDATETIME() END,
            updatedAt = SYSDATETIME(), lastActivityAt = SYSDATETIME(), editCount = editCount + 1,
            fileCount = (SELECT COUNT(*) FROM dbo.rq_Files WHERE ownerType = N'request' AND ownerId = @rid)
        WHERE requestId = @rid;

        INSERT INTO dbo.rq_Activities (requestId, userId, action, note)
        VALUES (@rid, @uid, CASE WHEN @status = N'returned' THEN N'resubmit' ELSE N'edit' END, @note);
        COMMIT;
        SELECT @status AS previousStatus;`);

    ok(req, res, { requestId: rid });
    later(async () => {
      const first = (await pool.request().input('rid', sql.Int, rid)
        .query(`SELECT userId FROM dbo.rq_RequestApprovers WHERE requestId = @rid AND status = N'pending'`)).recordset.map((x) => x.userId);
      const resub = r.recordset[0]?.previousStatus === 'returned';
      await notify({
        userIds: first, actorId: uid, type: 'approval', requestId: rid,
        title: resub ? 'Đề xuất đã được bổ sung, gửi lại để bạn duyệt' : 'Đề xuất bạn cần duyệt vừa được sửa',
        body: `${cur.typeName}: ${str(b.title, 300) || cur.title}`,
      });
    });
  } catch (err) { handleError(res, err, 'PUT /requests/:id'); }
});

/* ================================ DUYỆT ================================ */

/**
 * Duyệt / từ chối / trả lại 1 đề xuất (1 transaction, khoá dòng đề xuất).
 * - approve: bước "all" chờ đủ người; bước "any" 1 người duyệt là xong, người còn lại → skipped.
 *   Xong bước cuối → approved. Xong bước giữa → mở bước kế tiếp.
 * - reject: kết thúc đề xuất. return: trả về người gửi để bổ sung (sửa xong gửi lại từ bước 1).
 */
async function actOne(pool, rid, uid, action, note) {
  const r = await pool.request()
    .input('rid', sql.Int, rid).input('uid', sql.Int, uid)
    .input('action', sql.NVarChar(10), action).input('note', sql.NVarChar(1000), note || null)
    .query(`
      SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @status NVARCHAR(20), @step INT, @count INT, @mode NVARCHAR(5), @result NVARCHAR(20) = N'pending', @next INT = NULL;
      SELECT @status = status, @step = currentStep, @count = stepCount
      FROM dbo.rq_Requests WITH (UPDLOCK, HOLDLOCK) WHERE requestId = @rid AND isDeleted = 0;
      IF @status IS NULL THROW 50040, N'Không tìm thấy đề xuất', 1;
      IF @status <> N'pending' THROW 50041, N'Đề xuất không còn ở trạng thái chờ duyệt', 1;
      IF NOT EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers WHERE requestId = @rid AND stepNo = @step AND userId = @uid AND status = N'pending')
        THROW 50042, N'Bạn không phải người duyệt ở bước hiện tại hoặc đã xử lý rồi', 1;
      SELECT TOP 1 @mode = stepMode FROM dbo.rq_RequestApprovers WHERE requestId = @rid AND stepNo = @step;

      IF @action = N'approve'
      BEGIN
        UPDATE dbo.rq_RequestApprovers SET status = N'approved', note = @note, actedAt = SYSDATETIME()
        WHERE requestId = @rid AND stepNo = @step AND userId = @uid;
        IF @mode = N'any'
          UPDATE dbo.rq_RequestApprovers SET status = N'skipped' WHERE requestId = @rid AND stepNo = @step AND status = N'pending';
        IF NOT EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers WHERE requestId = @rid AND stepNo = @step AND status = N'pending')
        BEGIN
          IF @step < @count
          BEGIN
            SET @next = @step + 1;
            UPDATE dbo.rq_RequestApprovers SET status = N'pending' WHERE requestId = @rid AND stepNo = @next AND status = N'waiting';
            UPDATE dbo.rq_Requests SET currentStep = @next WHERE requestId = @rid;
            SET @result = N'next';
          END
          ELSE
          BEGIN
            UPDATE dbo.rq_Requests SET status = N'approved', finishedAt = SYSDATETIME() WHERE requestId = @rid;
            SET @result = N'approved';
          END
        END
      END
      ELSE IF @action = N'reject'
      BEGIN
        UPDATE dbo.rq_RequestApprovers SET status = N'rejected', note = @note, actedAt = SYSDATETIME()
        WHERE requestId = @rid AND stepNo = @step AND userId = @uid;
        UPDATE dbo.rq_RequestApprovers SET status = N'skipped' WHERE requestId = @rid AND status = N'pending';
        UPDATE dbo.rq_Requests SET status = N'rejected', finishedAt = SYSDATETIME() WHERE requestId = @rid;
        SET @result = N'rejected';
      END
      ELSE IF @action = N'return'
      BEGIN
        UPDATE dbo.rq_RequestApprovers SET status = N'returned', note = @note, actedAt = SYSDATETIME()
        WHERE requestId = @rid AND stepNo = @step AND userId = @uid;
        UPDATE dbo.rq_RequestApprovers SET status = N'skipped' WHERE requestId = @rid AND status = N'pending';
        UPDATE dbo.rq_Requests SET status = N'returned' WHERE requestId = @rid;
        SET @result = N'returned';
      END
      ELSE THROW 50043, N'Thao tác không hợp lệ', 1;

      UPDATE dbo.rq_Requests SET lastActivityAt = SYSDATETIME(), updatedAt = SYSDATETIME() WHERE requestId = @rid;
      INSERT INTO dbo.rq_Activities (requestId, userId, action, stepNo, note) VALUES (@rid, @uid, @action, @step, @note);
      COMMIT;

      SELECT @result AS result, @step AS stepNo, @next AS nextStep, r.requesterId, r.title, r.typeName,
             (SELECT fullName FROM dbo.Users WHERE userID = @uid) AS actorName
      FROM dbo.rq_Requests r WHERE r.requestId = @rid;
      SELECT userId, status FROM dbo.rq_RequestApprovers WHERE requestId = @rid;
      SELECT userId FROM dbo.rq_RequestFollowers WHERE requestId = @rid;`);
  return { ...r.recordsets[0][0], approvers: r.recordsets[1], followers: r.recordsets[2].map((x) => x.userId) };
}

async function notifyAfterAct(rid, uid, a, note) {
  const actor = a.actorName || 'Người duyệt';
  const body = `${a.typeName}: ${a.title}${note ? ` — "${note}"` : ''}`;
  const touched = a.approvers.filter((x) => ['approved', 'rejected', 'returned'].includes(x.status)).map((x) => x.userId);
  if (a.result === 'next') {
    const next = a.approvers.filter((x) => x.status === 'pending').map((x) => x.userId);
    await notify({ userIds: next, actorId: uid, type: 'approval', requestId: rid, title: 'Có đề xuất cần bạn duyệt', body });
    await notify({ userIds: [a.requesterId], actorId: uid, type: 'step', requestId: rid, title: `${actor} đã duyệt bước ${a.stepNo} đề xuất của bạn`, body, push: false });
  } else if (a.result === 'pending') {
    await notify({ userIds: [a.requesterId], actorId: uid, type: 'step', requestId: rid, title: `${actor} đã duyệt đề xuất của bạn (chờ người duyệt khác cùng bước)`, body, push: false });
  } else if (a.result === 'approved') {
    await notify({ userIds: [a.requesterId], actorId: uid, type: 'approved', requestId: rid, title: '✅ Đề xuất của bạn đã được duyệt', body });
    await notify({ userIds: [...a.followers, ...touched], actorId: uid, type: 'approved', requestId: rid, title: 'Đề xuất bạn theo dõi đã được duyệt xong', body, push: false });
  } else if (a.result === 'rejected') {
    await notify({ userIds: [a.requesterId], actorId: uid, type: 'rejected', requestId: rid, title: `❌ ${actor} đã từ chối đề xuất của bạn`, body });
    await notify({ userIds: [...a.followers, ...touched], actorId: uid, type: 'rejected', requestId: rid, title: `${actor} đã từ chối đề xuất`, body, push: false });
  } else if (a.result === 'returned') {
    await notify({ userIds: [a.requesterId], actorId: uid, type: 'returned', requestId: rid, title: `↩️ ${actor} trả lại đề xuất, cần bạn bổ sung`, body });
  }
}

function readAction(req) {
  const action = req.params.action;
  if (!['approve', 'reject', 'return'].includes(action)) throw new D.ValidationError('Thao tác không hợp lệ');
  const note = str(req.body?.note, 1000);
  if ((action === 'reject' || action === 'return') && !note) {
    throw new D.ValidationError(action === 'reject' ? 'Vui lòng nhập lý do từ chối' : 'Vui lòng ghi rõ cần bổ sung gì');
  }
  return { action, note };
}

// Express 5: không dùng regex trong path → đăng ký từng thao tác
for (const action of ['approve', 'reject', 'return']) {
  router.post(`/requests/:id/${action}`, moduleUser, async (req, res) => {
    try {
      const rid = parseId(req.params.id);
      if (!rid) return res.status(400).json({ success: false, message: 'Mã đề xuất không hợp lệ' });
      req.params.action = action;
      const { note } = readAction(req);
      const pool = await poolPromise;
      const a = await actOne(pool, rid, req.user.userID, action, note);
      ok(req, res, { requestId: rid, result: a.result });
      later(() => notifyAfterAct(rid, req.user.userID, a, note));
    } catch (err) { handleError(res, err, `POST /requests/:id/${action}`); }
  });
}

// Duyệt / từ chối hàng loạt (từng đề xuất 1 transaction; lỗi đề xuất nào báo đề xuất đó)
router.post('/requests/bulk', moduleUser, async (req, res) => {
  try {
    const list = D.ids(req.body?.ids, 100);
    if (!list.length) throw new D.ValidationError('Chưa chọn đề xuất');
    req.params.action = req.body?.action;
    const { action, note } = readAction(req);
    if (action === 'return') throw new D.ValidationError('Trả lại chỉ làm từng đề xuất');
    const pool = await poolPromise;
    const results = [];
    for (const rid of list) {
      try {
        const a = await actOne(pool, rid, req.user.userID, action, note);
        results.push({ requestId: rid, ok: true, result: a.result });
        later(() => notifyAfterAct(rid, req.user.userID, a, note));
      } catch (e) {
        results.push({ requestId: rid, ok: false, message: e?.number >= 50000 ? e.message : 'Lỗi máy chủ' });
        if (!(e?.number >= 50000)) console.error('❌ [rq] bulk', rid, e);
      }
    }
    ok(req, res, { results, done: results.filter((x) => x.ok).length });
  } catch (err) { handleError(res, err, 'POST /requests/bulk'); }
});

router.post('/requests/:id/cancel', moduleUser, async (req, res) => {
  try {
    const rid = parseId(req.params.id);
    if (!rid) return res.status(400).json({ success: false, message: 'Mã đề xuất không hợp lệ' });
    const uid = req.user.userID;
    const note = str(req.body?.note, 1000) || null;
    const pool = await poolPromise;
    const r = await pool.request().input('rid', sql.Int, rid).input('uid', sql.Int, uid).input('note', sql.NVarChar(1000), note).query(`
      SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @status NVARCHAR(20), @requester INT;
      SELECT @status = status, @requester = requesterId FROM dbo.rq_Requests WITH (UPDLOCK, HOLDLOCK) WHERE requestId = @rid AND isDeleted = 0;
      IF @requester IS NULL OR @requester <> @uid THROW 50060, N'Chỉ người gửi được huỷ đề xuất', 1;
      IF @status NOT IN (N'pending', N'returned') THROW 50061, N'Đề xuất đã kết thúc, không huỷ được', 1;
      -- biến bảng (không dùng #temp: kết nối trong pool sống lâu, #temp còn lại làm lần sau lỗi)
      DECLARE @n TABLE (userId INT);
      INSERT INTO @n SELECT userId FROM dbo.rq_RequestApprovers WHERE requestId = @rid AND status IN (N'pending', N'approved');
      UPDATE dbo.rq_RequestApprovers SET status = N'skipped' WHERE requestId = @rid AND status = N'pending';
      UPDATE dbo.rq_Requests SET status = N'cancelled', finishedAt = SYSDATETIME(), lastActivityAt = SYSDATETIME(), updatedAt = SYSDATETIME()
      WHERE requestId = @rid;
      INSERT INTO dbo.rq_Activities (requestId, userId, action, note) VALUES (@rid, @uid, N'cancel', @note);
      COMMIT;
      SELECT r.title, r.typeName, r.requesterName FROM dbo.rq_Requests r WHERE r.requestId = @rid;
      SELECT userId FROM @n UNION SELECT userId FROM dbo.rq_RequestFollowers WHERE requestId = @rid;`);
    ok(req, res, { requestId: rid });
    const info = r.recordsets[0][0] || {};
    later(() => notify({
      userIds: r.recordsets[1].map((x) => x.userId), actorId: uid, type: 'cancelled', requestId: rid,
      title: `${info.requesterName || 'Người gửi'} đã huỷ đề xuất`, body: `${info.typeName}: ${info.title}`, push: false,
    }));
  } catch (err) { handleError(res, err, 'POST /requests/:id/cancel'); }
});

/* ================================ NGƯỜI THEO DÕI ================================ */

async function loadAccess(pool, rid, uid, admin) {
  const r = await pool.request().input('rid', sql.Int, rid).input('uid', sql.Int, uid).input('isAdmin', sql.Bit, admin).query(`
    SELECT r.requestId, r.requesterId, r.requesterName, r.title, r.typeName, r.status, t.options,
           CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers a WHERE a.requestId = r.requestId AND a.userId = @uid) THEN 1 ELSE 0 END AS bit) AS isApprover
    FROM dbo.rq_Requests r LEFT JOIN dbo.rq_Types t ON t.typeId = r.typeId
    WHERE r.requestId = @rid AND r.isDeleted = 0 AND ${canViewExpr('r')}`);
  const row = r.recordset[0];
  if (!row) throw httpError(404, 'Không tìm thấy đề xuất hoặc bạn không được xem');
  return row;
}

router.post('/requests/:id/followers', moduleUser, async (req, res) => {
  try {
    const rid = parseId(req.params.id);
    if (!rid) return res.status(400).json({ success: false, message: 'Mã đề xuất không hợp lệ' });
    const uid = req.user.userID;
    const pool = await poolPromise;
    const acc = await loadAccess(pool, rid, uid, isAdmin(req));
    const options = D.normalizeOptions(D.parseJson(acc.options, {}));
    if (!options.allowFollowers || !(acc.requesterId === uid || acc.isApprover || isAdmin(req))) {
      throw httpError(403, 'Bạn không thêm được người theo dõi cho đề xuất này');
    }
    const active = await activeUserIds(pool, D.ids(req.body?.userIds, 50));
    const list = [...active].filter((id) => id !== acc.requesterId);
    if (!list.length) throw new D.ValidationError('Chưa chọn người theo dõi');
    const r = await pool.request().input('rid', sql.Int, rid).input('uid', sql.Int, uid)
      .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(list)).query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @added TABLE (userId INT);
        INSERT INTO dbo.rq_RequestFollowers (requestId, userId, addedBy)
        OUTPUT INSERTED.userId INTO @added
        SELECT @rid, x.id, @uid FROM (SELECT DISTINCT CAST([value] AS INT) AS id FROM OPENJSON(@ids)) x
        WHERE NOT EXISTS (SELECT 1 FROM dbo.rq_RequestFollowers f WHERE f.requestId = @rid AND f.userId = x.id);
        IF EXISTS (SELECT 1 FROM @added)
          INSERT INTO dbo.rq_Activities (requestId, userId, action, note)
          SELECT @rid, @uid, N'follow', CONCAT(N'Thêm ', COUNT(*), N' người theo dõi') FROM @added;
        COMMIT;
        SELECT userId FROM @added;`);
    const added = r.recordset.map((x) => x.userId);
    ok(req, res, { added });
    later(() => notify({ userIds: added, actorId: uid, type: 'follow', requestId: rid, title: 'Bạn được thêm theo dõi một đề xuất', body: `${acc.typeName}: ${acc.title}`, push: false }));
  } catch (err) { handleError(res, err, 'POST /requests/:id/followers'); }
});

router.delete('/requests/:id/followers/:userId', moduleUser, async (req, res) => {
  try {
    const rid = parseId(req.params.id);
    const target = parseId(req.params.userId);
    if (!rid || !target) return res.status(400).json({ success: false, message: 'Tham số không hợp lệ' });
    const uid = req.user.userID;
    const pool = await poolPromise;
    const acc = await loadAccess(pool, rid, uid, isAdmin(req));
    if (!(target === uid || acc.requesterId === uid || isAdmin(req))) throw httpError(403, 'Bạn không bỏ được người theo dõi này');
    await pool.request().input('rid', sql.Int, rid).input('target', sql.Int, target)
      .query(`DELETE FROM dbo.rq_RequestFollowers WHERE requestId = @rid AND userId = @target`);
    ok(req, res, { removed: target });
  } catch (err) { handleError(res, err, 'DELETE /requests/:id/followers/:userId'); }
});

/* ================================ BÌNH LUẬN ================================ */

router.post('/requests/:id/comments', moduleUser, async (req, res) => {
  try {
    const rid = parseId(req.params.id);
    if (!rid) return res.status(400).json({ success: false, message: 'Mã đề xuất không hợp lệ' });
    const uid = req.user.userID;
    const b = req.body || {};
    const body = String(b.body || '').trim().slice(0, 4000);
    const pool = await poolPromise;
    const acc = await loadAccess(pool, rid, uid, isAdmin(req));
    const files = F.readAttachments(b.attachments, uid, { max: 20 });
    if (!body && !files.length) throw new D.ValidationError('Bình luận đang trống');
    const mentions = [...(await activeUserIds(pool, D.ids(b.mentionIds, 30)))].filter((id) => id !== uid);

    const r = await pool.request()
      .input('rid', sql.Int, rid).input('uid', sql.Int, uid)
      .input('parent', sql.BigInt, parseId(b.parentId))
      .input('body', sql.NVarChar(4000), body || null)
      .input('files', sql.NVarChar(sql.MAX), JSON.stringify(files))
      .input('mentions', sql.NVarChar(sql.MAX), JSON.stringify(mentions))
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @cid BIGINT;
        IF @parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.rq_Comments WHERE commentId = @parent AND requestId = @rid)
          SET @parent = NULL;
        INSERT INTO dbo.rq_Comments (requestId, parentId, userId, body) VALUES (@rid, @parent, @uid, @body);
        SET @cid = SCOPE_IDENTITY();
        INSERT INTO dbo.rq_Files (storageKey, fileName, mimeType, sizeBytes, hasThumb, width, height,
          ownerType, ownerId, requestId, fieldKey, uploadedBy)
        SELECT j.[key], j.name, j.mime, j.size, ISNULL(j.hasThumb, 0), j.width, j.height,
          N'comment', @cid, @rid, NULL, @uid FROM ${FILES_JSON};
        -- người được @nhắc tên mà chưa liên quan → thêm theo dõi để xem được đề xuất
        INSERT INTO dbo.rq_RequestFollowers (requestId, userId, addedBy)
        SELECT @rid, x.id, @uid FROM (SELECT DISTINCT CAST([value] AS INT) AS id FROM OPENJSON(@mentions)) x
        WHERE NOT EXISTS (SELECT 1 FROM dbo.rq_RequestFollowers f WHERE f.requestId = @rid AND f.userId = x.id)
          AND NOT EXISTS (SELECT 1 FROM dbo.rq_RequestApprovers a WHERE a.requestId = @rid AND a.userId = x.id)
          AND NOT EXISTS (SELECT 1 FROM dbo.rq_Requests q WHERE q.requestId = @rid AND q.requesterId = x.id);
        UPDATE dbo.rq_Requests SET commentCount = commentCount + 1, lastActivityAt = SYSDATETIME() WHERE requestId = @rid;
        COMMIT;

        SELECT c.commentId, c.parentId, c.userId, u.fullName, c.body, c.isDeleted, ${dt('c.createdAt', 'createdAt')}, ${dt('c.updatedAt', 'updatedAt')}
        FROM dbo.rq_Comments c JOIN dbo.Users u ON u.userID = c.userId WHERE c.commentId = @cid;
        SELECT ${FILE_COLS} FROM dbo.rq_Files f WHERE f.ownerType = N'comment' AND f.ownerId = @cid;
        SELECT userId FROM dbo.rq_RequestApprovers WHERE requestId = @rid AND status <> N'waiting'
        UNION SELECT userId FROM dbo.rq_RequestFollowers WHERE requestId = @rid
        UNION SELECT requesterId FROM dbo.rq_Requests WHERE requestId = @rid;`);

    const comment = commentOut(r.recordsets[0][0], groupCommentFiles(r.recordsets[1]));
    ok(req, res, comment);

    later(async () => {
      const who = comment.fullName || 'Ai đó';
      const preview = body ? body.replace(/\s+/g, ' ').slice(0, 120) : '📎 Tệp đính kèm';
      const mentionSet = new Set(mentions);
      await notify({ userIds: mentions, actorId: uid, type: 'mention', requestId: rid, title: `${who} nhắc đến bạn trong đề xuất "${acc.title}"`, body: preview });
      await notify({
        userIds: r.recordsets[2].map((x) => x.userId).filter((id) => !mentionSet.has(id)),
        actorId: uid, type: 'comment', requestId: rid, title: `${who} bình luận đề xuất "${acc.title}"`, body: preview,
      });
    });
  } catch (err) { handleError(res, err, 'POST /requests/:id/comments'); }
});

router.delete('/comments/:commentId', moduleUser, async (req, res) => {
  try {
    const cid = parseId(req.params.commentId);
    if (!cid) return res.status(400).json({ success: false, message: 'Mã bình luận không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('cid', sql.BigInt, cid).input('uid', sql.Int, req.user.userID).input('isAdmin', sql.Bit, isAdmin(req)).query(`
      SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @rid INT;
      UPDATE dbo.rq_Comments SET isDeleted = 1, updatedAt = SYSDATETIME(), @rid = requestId
      WHERE commentId = @cid AND isDeleted = 0 AND (userId = @uid OR @isAdmin = 1);
      IF @rid IS NOT NULL UPDATE dbo.rq_Requests SET commentCount = CASE WHEN commentCount > 0 THEN commentCount - 1 ELSE 0 END WHERE requestId = @rid;
      COMMIT;
      SELECT @rid AS requestId;`);
    if (!r.recordset[0]?.requestId) return res.status(404).json({ success: false, message: 'Không tìm thấy bình luận của bạn' });
    ok(req, res, { commentId: cid });
  } catch (err) { handleError(res, err, 'DELETE /comments/:id'); }
});

/* ================================ THÔNG BÁO ================================ */

router.get('/notifications', moduleUser, async (req, res) => {
  try {
    const before = Number(req.query.beforeId) > 0 ? Number(req.query.beforeId) : null;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const pool = await poolPromise;
    const r = await pool.request().input('uid', sql.Int, req.user.userID).input('before', sql.BigInt, before).input('limit', sql.Int, limit)
      .input('unread', sql.Bit, req.query.unread === '1')
      .query(`
        SELECT TOP (@limit) n.notificationId, n.type, n.requestId, n.actorId, n.title, n.body, n.url, n.isRead, ${dt('n.createdAt', 'createdAt')}
        FROM dbo.rq_Notifications n
        WHERE n.userId = @uid AND (@before IS NULL OR n.notificationId < @before) AND (@unread = 0 OR n.isRead = 0)
        ORDER BY n.notificationId DESC;
        SELECT COUNT(*) AS unread FROM dbo.rq_Notifications WHERE userId = @uid AND isRead = 0;`);
    ok(req, res, {
      rows: r.recordsets[0].map((n) => ({ ...n, notificationId: num(n.notificationId) })),
      unread: r.recordsets[1][0]?.unread || 0,
    });
  } catch (err) { handleError(res, err, 'GET /notifications'); }
});

router.post('/notifications/read', moduleUser, async (req, res) => {
  try {
    const all = req.body?.all === true;
    const list = D.ids(req.body?.ids, 500);
    const rid = parseId(req.body?.requestId);
    if (!all && !list.length && !rid) throw new D.ValidationError('Chưa chọn thông báo');
    const pool = await poolPromise;
    await pool.request().input('uid', sql.Int, req.user.userID).input('all', sql.Bit, all)
      .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(list)).input('rid', sql.Int, rid)
      .query(`
        UPDATE dbo.rq_Notifications SET isRead = 1
        WHERE userId = @uid AND isRead = 0
          AND (@all = 1 OR requestId = @rid OR notificationId IN (SELECT CAST([value] AS BIGINT) FROM OPENJSON(@ids)))`);
    ok(req, res, { done: true });
  } catch (err) { handleError(res, err, 'POST /notifications/read'); }
});

module.exports = router;
module.exports.clearDirectoryCache = clearDirectoryCache;
