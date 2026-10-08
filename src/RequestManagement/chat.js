// RequestManagement/chat.js — chat của module 18: 1-1, nhóm, và nhóm chat gắn với 1 đề xuất.
// Không dùng WebSocket (server yếu + IIS ARR): frontend hỏi tin mới mỗi vài giây khi đang mở
// hội thoại (GET …/messages?afterId=), câu hỏi dùng index (conversationId, messageId) nên rất nhẹ.
const express = require('express');
const { sql, poolPromise } = require('../db');
const C = require('./common');
const D = require('./definition');
const F = require('./files');
const { pushToUsers, later } = require('./notify');

const router = express.Router();
const { moduleUser, dt, parseId, handleError, httpError, ok, canViewExpr, isAdmin, activeUserIds } = C;
const num = (v) => (v === null || v === undefined ? null : Number(v));

const FILE_COLS = `f.fileId, f.storageKey, f.fileName, f.mimeType, f.sizeBytes, f.hasThumb, f.width, f.height,
  f.ownerType, f.ownerId, f.fieldKey, f.uploadedBy, ${dt('f.createdAt', 'createdAt')}`;

function messagesOut(rows, files) {
  const byMsg = new Map();
  for (const f of files) {
    const k = num(f.ownerId);
    if (!byMsg.has(k)) byMsg.set(k, []);
    byMsg.get(k).push(F.fileOut(f));
  }
  return rows.map((m) => ({
    messageId: num(m.messageId),
    userId: m.userId,
    body: m.isDeleted ? null : m.body,
    isDeleted: !!m.isDeleted,
    refRequestId: m.refRequestId,
    refTitle: m.refTitle || null,
    refStatus: m.refStatus || null,
    createdAt: m.createdAt,
    files: m.isDeleted ? [] : byMsg.get(num(m.messageId)) || [],
  }));
}

async function requireMember(pool, cid, uid) {
  const r = await pool.request().input('cid', sql.Int, cid).input('uid', sql.Int, uid).query(`
    SELECT c.conversationId, c.kind, c.title, c.requestId, m.lastReadMessageId
    FROM dbo.rq_Conversations c
    JOIN dbo.rq_ConversationMembers m ON m.conversationId = c.conversationId AND m.userId = @uid
    WHERE c.conversationId = @cid`);
  if (!r.recordset[0]) throw httpError(404, 'Không tìm thấy hội thoại hoặc bạn không ở trong hội thoại');
  return r.recordset[0];
}

/* ------------------------------ Danh sách hội thoại ------------------------------ */
router.get('/conversations', moduleUser, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('uid', sql.Int, req.user.userID).query(`
      SELECT c.conversationId, c.kind, c.title, c.requestId, rq.title AS requestTitle, rq.status AS requestStatus,
             ${dt('ISNULL(c.lastMessageAt, c.createdAt)', 'lastAt')},
             lm.userId AS lastUserId, lm.body AS lastBody, lm.isDeleted AS lastDeleted,
             CAST(CASE WHEN lm.messageId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.rq_Files f WHERE f.ownerType = N'message' AND f.ownerId = lm.messageId) THEN 0 ELSE 1 END AS bit) AS lastHasFile,
             (SELECT COUNT(*) FROM dbo.rq_Messages x WHERE x.conversationId = c.conversationId
                AND x.messageId > m.lastReadMessageId AND x.userId <> @uid AND x.isDeleted = 0) AS unread,
             (SELECT STRING_AGG(CAST(cm.userId AS NVARCHAR(12)), N',') FROM dbo.rq_ConversationMembers cm
               WHERE cm.conversationId = c.conversationId) AS memberIds
      FROM dbo.rq_ConversationMembers m
      JOIN dbo.rq_Conversations c ON c.conversationId = m.conversationId
      LEFT JOIN dbo.rq_Messages lm ON lm.messageId = c.lastMessageId
      LEFT JOIN dbo.rq_Requests rq ON rq.requestId = c.requestId
      WHERE m.userId = @uid
      ORDER BY ISNULL(c.lastMessageAt, c.createdAt) DESC`);
    ok(req, res, r.recordset.map(({ memberIds, lastDeleted, lastBody, lastHasFile, ...c }) => ({
      ...c,
      lastBody: lastDeleted ? 'Tin nhắn đã thu hồi' : lastBody || (c.lastUserId && lastHasFile ? '📎 Tệp đính kèm' : null),
      memberIds: memberIds ? memberIds.split(',').map(Number) : [],
    })));
  } catch (err) { handleError(res, err, 'GET /chat/conversations'); }
});

/* ------------------------------ Mở / tạo hội thoại ------------------------------ */
// { kind: 'direct', userId } · { kind: 'request', requestId } · { kind: 'group', title, userIds }
router.post('/conversations', moduleUser, async (req, res) => {
  try {
    const uid = req.user.userID;
    const b = req.body || {};
    const pool = await poolPromise;
    let key, kind, title = null, requestId = null, members = [uid];

    if (b.kind === 'direct') {
      const other = parseId(b.userId);
      if (!other || other === uid) throw new D.ValidationError('Chọn người để nhắn tin');
      if (!(await activeUserIds(pool, [other])).has(other)) throw new D.ValidationError('Người này không còn hoạt động');
      kind = 'direct';
      key = `d${Math.min(uid, other)}_${Math.max(uid, other)}`;
      members.push(other);
    } else if (b.kind === 'request') {
      requestId = parseId(b.requestId);
      if (!requestId) throw new D.ValidationError('Thiếu mã đề xuất');
      const r = await pool.request().input('rid', sql.Int, requestId).input('uid', sql.Int, uid).input('isAdmin', sql.Bit, isAdmin(req)).query(`
        SELECT r.requestId, r.title, r.requesterId FROM dbo.rq_Requests r WHERE r.requestId = @rid AND r.isDeleted = 0 AND ${canViewExpr('r')};
        SELECT userId FROM dbo.rq_RequestApprovers WHERE requestId = @rid
        UNION SELECT userId FROM dbo.rq_RequestFollowers WHERE requestId = @rid;`);
      const rq = r.recordsets[0][0];
      if (!rq) throw httpError(404, 'Không tìm thấy đề xuất hoặc bạn không được xem');
      kind = 'request';
      key = `r${requestId}`;
      title = rq.title;
      members = [uid, rq.requesterId, ...r.recordsets[1].map((x) => x.userId)];
    } else if (b.kind === 'group') {
      title = String(b.title || '').trim().slice(0, 200);
      if (!title) throw new D.ValidationError('Đặt tên nhóm chat');
      const active = await activeUserIds(pool, D.ids(b.userIds, 200));
      if (!active.size) throw new D.ValidationError('Chọn thành viên nhóm');
      kind = 'group';
      key = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      members.push(...active);
    } else {
      throw new D.ValidationError('Loại hội thoại không hợp lệ');
    }
    members = [...new Set(members)];

    const r = await pool.request()
      .input('key', sql.NVarChar(60), key).input('kind', sql.NVarChar(10), kind)
      .input('title', sql.NVarChar(200), title).input('rid', sql.Int, requestId).input('uid', sql.Int, uid)
      .input('members', sql.NVarChar(sql.MAX), JSON.stringify(members))
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @cid INT;
        SELECT @cid = conversationId FROM dbo.rq_Conversations WITH (UPDLOCK, HOLDLOCK) WHERE uniqueKey = @key;
        IF @cid IS NULL
        BEGIN
          INSERT INTO dbo.rq_Conversations (kind, uniqueKey, title, requestId, createdBy) VALUES (@kind, @key, @title, @rid, @uid);
          SET @cid = SCOPE_IDENTITY();
        END
        ELSE IF @kind = N'request'
          UPDATE dbo.rq_Conversations SET title = @title WHERE conversationId = @cid;
        -- nhóm chat của đề xuất: đồng bộ thêm người mới liên quan (người duyệt / theo dõi mới)
        INSERT INTO dbo.rq_ConversationMembers (conversationId, userId, lastReadMessageId)
        SELECT @cid, x.id, ISNULL((SELECT lastMessageId FROM dbo.rq_Conversations WHERE conversationId = @cid), 0)
        FROM (SELECT DISTINCT CAST([value] AS INT) AS id FROM OPENJSON(@members)) x
        WHERE NOT EXISTS (SELECT 1 FROM dbo.rq_ConversationMembers m WHERE m.conversationId = @cid AND m.userId = x.id);
        COMMIT;
        SELECT @cid AS conversationId;`);
    ok(req, res, { conversationId: r.recordset[0].conversationId });
  } catch (err) { handleError(res, err, 'POST /chat/conversations'); }
});

/* ------------------------------ Tin nhắn ------------------------------ */
// ?afterId=  → tin mới hơn (polling) · ?beforeId= → tin cũ hơn (cuộn lên) · không có → 40 tin gần nhất
router.get('/conversations/:id/messages', moduleUser, async (req, res) => {
  try {
    const cid = parseId(req.params.id);
    if (!cid) return res.status(400).json({ success: false, message: 'Mã hội thoại không hợp lệ' });
    const uid = req.user.userID;
    const pool = await poolPromise;
    const conv = await requireMember(pool, cid, uid);
    const after = Number(req.query.afterId) > 0 ? Number(req.query.afterId) : null;
    const before = Number(req.query.beforeId) > 0 ? Number(req.query.beforeId) : null;
    const limit = after ? 200 : 40;
    const r = await pool.request()
      .input('cid', sql.Int, cid).input('after', sql.BigInt, after).input('before', sql.BigInt, before).input('limit', sql.Int, limit)
      .query(`
        DECLARE @m TABLE (messageId BIGINT PRIMARY KEY);
        INSERT INTO @m
        SELECT TOP (@limit) messageId FROM dbo.rq_Messages
        WHERE conversationId = @cid
          AND (@after IS NULL OR messageId > @after)
          AND (@before IS NULL OR messageId < @before)
        ORDER BY CASE WHEN @after IS NULL THEN -messageId ELSE messageId END;

        SELECT x.messageId, x.userId, x.body, x.isDeleted, x.refRequestId, q.title AS refTitle, q.status AS refStatus,
               ${dt('x.createdAt', 'createdAt')}
        FROM dbo.rq_Messages x JOIN @m m ON m.messageId = x.messageId
        LEFT JOIN dbo.rq_Requests q ON q.requestId = x.refRequestId
        ORDER BY x.messageId;
        SELECT ${FILE_COLS} FROM dbo.rq_Files f JOIN @m m ON m.messageId = f.ownerId WHERE f.ownerType = N'message';
        SELECT userId, lastReadMessageId FROM dbo.rq_ConversationMembers WHERE conversationId = @cid;`);
    ok(req, res, {
      conversation: { ...conv, lastReadMessageId: num(conv.lastReadMessageId) },
      messages: messagesOut(r.recordsets[0], r.recordsets[1]),
      // ai đã đọc tới đâu → hiện "Đã xem"
      reads: r.recordsets[2].map((x) => ({ userId: x.userId, lastReadMessageId: num(x.lastReadMessageId) })),
      hasMore: !after && r.recordsets[0].length === limit,
    });
  } catch (err) { handleError(res, err, 'GET /chat/conversations/:id/messages'); }
});

const lastPush = new Map(); // `${cid}|${userId}` → thời điểm push gần nhất (không spam điện thoại)

router.post('/conversations/:id/messages', moduleUser, async (req, res) => {
  try {
    const cid = parseId(req.params.id);
    if (!cid) return res.status(400).json({ success: false, message: 'Mã hội thoại không hợp lệ' });
    const uid = req.user.userID;
    const b = req.body || {};
    const body = String(b.body || '').trim().slice(0, 4000);
    const pool = await poolPromise;
    const conv = await requireMember(pool, cid, uid);
    const files = F.readAttachments(b.attachments, uid, { max: 20 });
    const refRequestId = parseId(b.refRequestId);
    if (!body && !files.length && !refRequestId) throw new D.ValidationError('Tin nhắn đang trống');

    const r = await pool.request()
      .input('cid', sql.Int, cid).input('uid', sql.Int, uid)
      .input('body', sql.NVarChar(4000), body || null)
      .input('ref', sql.Int, refRequestId)
      .input('files', sql.NVarChar(sql.MAX), JSON.stringify(files))
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @mid BIGINT;
        INSERT INTO dbo.rq_Messages (conversationId, userId, body, refRequestId) VALUES (@cid, @uid, @body, @ref);
        SET @mid = SCOPE_IDENTITY();
        INSERT INTO dbo.rq_Files (storageKey, fileName, mimeType, sizeBytes, hasThumb, width, height, ownerType, ownerId, requestId, uploadedBy)
        SELECT j.[key], j.name, j.mime, j.size, ISNULL(j.hasThumb, 0), j.width, j.height, N'message', @mid, NULL, @uid
        FROM OPENJSON(@files) WITH ([key] NVARCHAR(200) '$.key', name NVARCHAR(255) '$.name', mime NVARCHAR(150) '$.mime',
          size BIGINT '$.size', hasThumb BIT '$.hasThumb', width INT '$.width', height INT '$.height') j;
        UPDATE dbo.rq_Conversations SET lastMessageId = @mid, lastMessageAt = SYSDATETIME() WHERE conversationId = @cid;
        UPDATE dbo.rq_ConversationMembers SET lastReadMessageId = @mid WHERE conversationId = @cid AND userId = @uid;
        COMMIT;
        SELECT x.messageId, x.userId, x.body, x.isDeleted, x.refRequestId, q.title AS refTitle, q.status AS refStatus,
               ${dt('x.createdAt', 'createdAt')}, u.fullName
        FROM dbo.rq_Messages x JOIN dbo.Users u ON u.userID = x.userId
        LEFT JOIN dbo.rq_Requests q ON q.requestId = x.refRequestId WHERE x.messageId = @mid;
        SELECT ${FILE_COLS} FROM dbo.rq_Files f WHERE f.ownerType = N'message' AND f.ownerId = @mid;
        SELECT userId FROM dbo.rq_ConversationMembers WHERE conversationId = @cid AND userId <> @uid;`);
    const [msg] = messagesOut(r.recordsets[0], r.recordsets[1]);
    ok(req, res, msg);

    later(() => {
      const now = Date.now();
      // mỗi hội thoại tối đa 1 push / 45 giây / người — tin sau cùng tag sẽ thay thế thông báo cũ
      const targets = r.recordsets[2].map((x) => x.userId).filter((id) => {
        const k = `${cid}|${id}`;
        if (now - (lastPush.get(k) || 0) < 45000) return false;
        lastPush.set(k, now);
        return true;
      });
      if (lastPush.size > 20000) lastPush.clear();
      const sender = r.recordsets[0][0]?.fullName || 'Tin nhắn mới';
      const name = conv.kind === 'direct' ? sender : `${sender} · ${conv.title || 'Nhóm chat'}`;
      return pushToUsers(targets, {
        title: name,
        body: body ? body.slice(0, 140) : files.length ? '📎 Đã gửi tệp' : 'Đã gửi một đề xuất',
        url: `/request/chat?c=${cid}`,
        tag: `rq-chat-${cid}`,
      });
    });
  } catch (err) { handleError(res, err, 'POST /chat/conversations/:id/messages'); }
});

router.post('/conversations/:id/read', moduleUser, async (req, res) => {
  try {
    const cid = parseId(req.params.id);
    const last = Number(req.body?.lastMessageId);
    if (!cid || !(last > 0)) return res.status(400).json({ success: false, message: 'Tham số không hợp lệ' });
    const pool = await poolPromise;
    await pool.request().input('cid', sql.Int, cid).input('uid', sql.Int, req.user.userID).input('last', sql.BigInt, last).query(`
      UPDATE dbo.rq_ConversationMembers SET lastReadMessageId = @last
      WHERE conversationId = @cid AND userId = @uid AND lastReadMessageId < @last
        AND @last <= ISNULL((SELECT lastMessageId FROM dbo.rq_Conversations WHERE conversationId = @cid), 0)`);
    ok(req, res, { done: true });
  } catch (err) { handleError(res, err, 'POST /chat/conversations/:id/read'); }
});

// Thêm thành viên (nhóm)
router.post('/conversations/:id/members', moduleUser, async (req, res) => {
  try {
    const cid = parseId(req.params.id);
    if (!cid) return res.status(400).json({ success: false, message: 'Mã hội thoại không hợp lệ' });
    const pool = await poolPromise;
    const conv = await requireMember(pool, cid, req.user.userID);
    if (conv.kind !== 'group') throw new D.ValidationError('Chỉ thêm thành viên cho nhóm chat');
    const active = await activeUserIds(pool, D.ids(req.body?.userIds, 200));
    if (!active.size) throw new D.ValidationError('Chưa chọn người');
    await pool.request().input('cid', sql.Int, cid).input('ids', sql.NVarChar(sql.MAX), JSON.stringify([...active])).query(`
      INSERT INTO dbo.rq_ConversationMembers (conversationId, userId)
      SELECT @cid, x.id FROM (SELECT DISTINCT CAST([value] AS INT) AS id FROM OPENJSON(@ids)) x
      WHERE NOT EXISTS (SELECT 1 FROM dbo.rq_ConversationMembers m WHERE m.conversationId = @cid AND m.userId = x.id)`);
    ok(req, res, { added: [...active] });
  } catch (err) { handleError(res, err, 'POST /chat/conversations/:id/members'); }
});

// Rời nhóm
router.delete('/conversations/:id/members/me', moduleUser, async (req, res) => {
  try {
    const cid = parseId(req.params.id);
    if (!cid) return res.status(400).json({ success: false, message: 'Mã hội thoại không hợp lệ' });
    const pool = await poolPromise;
    const conv = await requireMember(pool, cid, req.user.userID);
    if (conv.kind === 'direct') throw new D.ValidationError('Không rời được hội thoại 1-1');
    await pool.request().input('cid', sql.Int, cid).input('uid', sql.Int, req.user.userID)
      .query(`DELETE FROM dbo.rq_ConversationMembers WHERE conversationId = @cid AND userId = @uid`);
    ok(req, res, { left: cid });
  } catch (err) { handleError(res, err, 'DELETE /chat/conversations/:id/members/me'); }
});

// Thu hồi tin nhắn của mình
router.delete('/messages/:messageId', moduleUser, async (req, res) => {
  try {
    const mid = parseId(req.params.messageId);
    if (!mid) return res.status(400).json({ success: false, message: 'Mã tin nhắn không hợp lệ' });
    const pool = await poolPromise;
    const r = await pool.request().input('mid', sql.BigInt, mid).input('uid', sql.Int, req.user.userID).query(`
      UPDATE dbo.rq_Messages SET isDeleted = 1 WHERE messageId = @mid AND userId = @uid AND isDeleted = 0`);
    if (!r.rowsAffected[0]) return res.status(404).json({ success: false, message: 'Không tìm thấy tin nhắn của bạn' });
    ok(req, res, { messageId: mid });
  } catch (err) { handleError(res, err, 'DELETE /chat/messages/:id'); }
});

module.exports = router;
