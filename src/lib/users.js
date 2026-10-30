export function serializeUser(row, { deviceCount } = {}) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_admin: Boolean(row.is_admin),
    theme: row.theme,
    created_at: row.created_at,
    ...(deviceCount === undefined ? {} : { device_count: deviceCount }),
  };
}

export function countDevices(db, userId) {
  return db.prepare('SELECT count(*) AS c FROM devices WHERE user_id = ?').get(userId).c;
}
