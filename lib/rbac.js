// Roles/permissions scaffold. Only OWNER accounts are created this session
// (see scripts/create-admin.js) but every route already checks a permission
// rather than "is logged in", so adding ADMIN/OPERATOR/VIEWER accounts later
// is additive — no route needs to change.
const ROLES = Object.freeze({
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR',
  VIEWER: 'VIEWER'
});

const PERMISSIONS = Object.freeze({
  VIEW_CHATS: 'view_chats',
  SEND_MESSAGE: 'send_message',
  BULK_SEND: 'bulk_send',
  SEND_GROUPS: 'send_groups',
  MANAGE_SCHEDULES: 'manage_schedules',
  UPLOAD_SHEET: 'upload_sheet',
  EXPORT_SHEET: 'export_sheet',
  VIEW_LOGS: 'view_logs',
  VIEW_AUDIT: 'view_audit',
  MANAGE_SESSION: 'manage_session'
});

// Every permission that exists. VIEWER only gets read-oriented ones;
// OPERATOR gets everything except session/account management; ADMIN and
// OWNER get everything. Adjust here, not per-route, when roles expand.
const ROLE_PERMISSIONS = {
  [ROLES.VIEWER]: [PERMISSIONS.VIEW_CHATS, PERMISSIONS.VIEW_LOGS],
  [ROLES.OPERATOR]: [
    PERMISSIONS.VIEW_CHATS,
    PERMISSIONS.SEND_MESSAGE,
    PERMISSIONS.BULK_SEND,
    PERMISSIONS.SEND_GROUPS,
    PERMISSIONS.MANAGE_SCHEDULES,
    PERMISSIONS.UPLOAD_SHEET,
    PERMISSIONS.EXPORT_SHEET,
    PERMISSIONS.VIEW_LOGS
  ],
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
  [ROLES.OWNER]: Object.values(PERMISSIONS)
};

function roleHasPermission(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

module.exports = { ROLES, PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission };
