// server/repo/lunchRepo.js
// NOTE: Đổi sang DB thực tế của bạn. Ở đây là ví dụ với Knex.
const knex = require("../db"); // ví dụ: module exports = require('knex')(config)

function toMenuShape(rows, entryRows) {
  if (!rows || !rows.length) return null;
  const m = rows[0];
  return {
    weeklyMenuId: m.weeklyMenuId,
    weekStartMonday: m.weekStartMonday, // 'YYYY-MM-DD'
    isLocked: !!m.isLocked,
    entries: (entryRows || []).map((r) => ({
      weeklyMenuEntryId: r.weeklyMenuEntryId,
      weeklyMenuId: r.weeklyMenuId,
      dayOfWeek: r.dayOfWeek,
      position: r.position,
      statusType: r.statusType, // 're'|'ws'|'ot'
      foodId: r.foodId,
      foodName: r.foodName,
      imageUrl: r.imageUrl || null
    }))
  };
}

async function getLatestWeeklyMenu() {
  // ví dụ: bảng weekly_menus + weekly_menu_entries
  const wm = await knex("weekly_menus")
    .select("weeklyMenuId", "weekStartMonday", "isLocked")
    .orderBy("weekStartMonday", "desc")
    .limit(1);

  if (!wm || !wm.length) return null;

  const entries = await knex("weekly_menu_entries as e")
    .leftJoin("foods as f", "f.foodId", "e.foodId")
    .select(
      "e.weeklyMenuEntryId",
      "e.weeklyMenuId",
      "e.dayOfWeek",
      "e.position",
      "e.statusType",
      "e.foodId",
      "f.foodName",
      "f.imageUrl"
    )
    .where("e.weeklyMenuId", wm[0].weeklyMenuId)
    .orderBy([{ column: "e.dayOfWeek" }, { column: "e.position" }]);

  return toMenuShape(wm, entries);
}

async function getWeeklyMenu(weeklyMenuId) {
  const wm = await knex("weekly_menus")
    .select("weeklyMenuId", "weekStartMonday", "isLocked")
    .where({ weeklyMenuId })
    .limit(1);

  if (!wm || !wm.length) return null;

  const entries = await knex("weekly_menu_entries as e")
    .leftJoin("foods as f", "f.foodId", "e.foodId")
    .select(
      "e.weeklyMenuEntryId",
      "e.weeklyMenuId",
      "e.dayOfWeek",
      "e.position",
      "e.statusType",
      "e.foodId",
      "f.foodName",
      "f.imageUrl"
    )
    .where("e.weeklyMenuId", weeklyMenuId)
    .orderBy([{ column: "e.dayOfWeek" }, { column: "e.position" }]);

  return toMenuShape(wm, entries);
}

/**
 * Trả về selections của user: mảng [ [entryId, isAction, quantity] ]
 * isAction: 1=chọn, 0=huỷ
 */
async function getUserSelections(weeklyMenuId, userId) {
  // ví dụ bảng: lunch_selections
  const rows = await knex("lunch_selections")
    .select("weeklyMenuEntryId as entryId", "isAction", "quantity")
    .where({ weeklyMenuId, userId });

  return rows.map((r) => [r.entryId, r.isAction ? 1 : 0, r.quantity || 1]);
}

// Lưu selections của thư ký: [{entryId, quantity}]
async function saveSecretarySelections(userId, weeklyMenuId, selections, createdBy) {
  // Xoá bản ghi cũ (cùng user + tuần) cho các entryId nằm trong selections, rồi insert lại
  const entryIds = selections.map((x) => Number(x.entryId));
  if (!entryIds.length) return;

  await knex("lunch_selections")
    .where({ userId, weeklyMenuId })
    .whereIn("weeklyMenuEntryId", entryIds)
    .del();

  const now = new Date();
  const rows = selections.map((s) => ({
    userId,
    weeklyMenuId,
    weeklyMenuEntryId: Number(s.entryId),
    isAction: 1,
    quantity: Math.max(1, parseInt(s.quantity || 1, 10)),
    createdBy,
    createdAt: now
  }));

  await knex.batchInsert("lunch_selections", rows, 100);
}

// Lưu selections của user thường: number[] (entryId list), 1 món/ngày
async function saveUserDaySelections(userId, weeklyMenuId, entryIds, createdBy) {
  // Chiến lược: với mỗi dayOfWeek, giữ 1 entryId (món) mới nhất:
  // 1) Lấy entry -> dayOfWeek map
  const entries = await knex("weekly_menu_entries")
    .select("weeklyMenuEntryId as entryId", "dayOfWeek")
    .where({ weeklyMenuId })
    .whereIn("weeklyMenuEntryId", entryIds);

  const pickByDay = {};
  entries.forEach((e) => (pickByDay[e.dayOfWeek] = e.entryId));

  // 2) Xoá toàn bộ chọn trước đó của user cho tuần (chỉ các entry thuộc những ngày đã pick)
  const days = Object.keys(pickByDay).map((d) => Number(d));
  if (days.length) {
    const oldEntryIds = await knex("weekly_menu_entries")
      .select("weeklyMenuEntryId")
      .where({ weeklyMenuId })
      .whereIn("dayOfWeek", days);

    await knex("lunch_selections")
      .where({ userId, weeklyMenuId })
      .whereIn(
        "weeklyMenuEntryId",
        oldEntryIds.map((r) => r.weeklyMenuEntryId)
      )
      .del();
  }

  // 3) Insert mới
  const now = new Date();
  const rows = Object.values(pickByDay).map((entryId) => ({
    userId,
    weeklyMenuId,
    weeklyMenuEntryId: Number(entryId),
    isAction: 1,
    quantity: 1,
    createdBy,
    createdAt: now
  }));

  if (rows.length) await knex.batchInsert("lunch_selections", rows, 100);
}

// Huỷ/Chọn 1 item
async function setItemAction(userId, weeklyMenuId, weeklyMenuEntryId, isAction, updatedBy) {
  // Upsert đơn giản:
  const exist = await knex("lunch_selections")
    .select("id")
    .where({ userId, weeklyMenuId, weeklyMenuEntryId })
    .first();

  const payload = {
    userId,
    weeklyMenuId,
    weeklyMenuEntryId,
    isAction: isAction ? 1 : 0,
    quantity: 1,
    updatedBy,
    updatedAt: new Date()
  };

  if (exist) {
    await knex("lunch_selections").where({ id: exist.id }).update(payload);
  } else {
    payload.createdBy = updatedBy;
    payload.createdAt = new Date();
    await knex("lunch_selections").insert(payload);
  }
}

// Update quantity (thư ký)
async function updateSecretaryQuantity(userId, weeklyMenuId, weeklyMenuEntryId, quantity, updatedBy) {
  const exist = await knex("lunch_selections")
    .select("id")
    .where({ userId, weeklyMenuId, weeklyMenuEntryId })
    .first();

  const payload = {
    userId,
    weeklyMenuId,
    weeklyMenuEntryId,
    isAction: 1,
    quantity: Math.max(1, parseInt(quantity || 1, 10)),
    updatedBy,
    updatedAt: new Date()
  };

  if (exist) {
    await knex("lunch_selections").where({ id: exist.id }).update(payload);
  } else {
    payload.createdAt = new Date();
    payload.createdBy = updatedBy;
    await knex("lunch_selections").insert(payload);
  }
}

// Lấy entries theo ngày (statusType)
async function getEntriesByDate(dateISO, statusType) {
  // Tìm weeklyMenuId chứa ngày dateISO
  // Giả sử weekStartMonday trong weekly_menus là thứ 2 đầu tuần
  const date = new Date(dateISO);
  const monday = new Date(date);
  const day = monday.getDay(); // 0..6 (Sun..Sat)
  const diff = (day === 0 ? -6 : 1) - day;
  monday.setDate(monday.getDate() + diff); // về thứ 2
  const weekStartMonday = monday.toISOString().slice(0, 10);

  const wm = await knex("weekly_menus")
    .select("weeklyMenuId")
    .where({ weekStartMonday })
    .first();

  if (!wm) return [];

  // dayOfWeek (1..7)
  const dayOfWeek = ((date.getDay() + 6) % 7) + 1;

  const entries = await knex("weekly_menu_entries as e")
    .leftJoin("foods as f", "f.foodId", "e.foodId")
    .select(
      "e.weeklyMenuEntryId",
      "e.weeklyMenuId",
      "e.dayOfWeek",
      "e.position",
      "e.statusType",
      "e.foodId",
      "f.foodName",
      "f.imageUrl"
    )
    .where({
      "e.weeklyMenuId": wm.weeklyMenuId,
      "e.dayOfWeek": dayOfWeek,
      "e.statusType": statusType
    })
    .orderBy([{ column: "e.position" }]);

  return entries;
}

// Lưu đặt theo ngày (thư ký)
async function saveDaySecretary(userId, dateISO, selections, createdBy) {
  // tìm weeklyMenuId & entryId hợp lệ
  if (!selections || !selections.length) return;

  // Lấy weeklyMenuId từ date
  const date = new Date(dateISO);
  const monday = new Date(date);
  const day = monday.getDay(); // 0..6
  const diff = (day === 0 ? -6 : 1) - day;
  monday.setDate(monday.getDate() + diff);
  const weekStartMonday = monday.toISOString().slice(0, 10);

  const wm = await knex("weekly_menus")
    .select("weeklyMenuId")
    .where({ weekStartMonday })
    .first();

  if (!wm) throw new Error("Tuần không tồn tại");

  const weeklyMenuId = wm.weeklyMenuId;
  const entryIds = selections.map((s) => Number(s.weeklyMenuEntryId));

  // Xoá cũ cho (user, tuần, entryIds) rồi insert lại
  await knex("lunch_selections")
    .where({ userId, weeklyMenuId })
    .whereIn("weeklyMenuEntryId", entryIds)
    .del();

  const now = new Date();
  const rows = selections.map((s) => ({
    userId,
    weeklyMenuId,
    weeklyMenuEntryId: Number(s.weeklyMenuEntryId),
    isAction: 1,
    quantity: Math.max(1, parseInt(s.quantity || 1, 10)),
    createdBy,
    createdAt: now
  }));

  await knex.batchInsert("lunch_selections", rows, 100);
}

module.exports = {
  getLatestWeeklyMenu,
  getWeeklyMenu,
  getUserSelections,
  saveSecretarySelections,
  saveUserDaySelections,
  setItemAction,
  updateSecretaryQuantity,
  getEntriesByDate,
  saveDaySecretary
};
