export type Permission =
  | 'canManageAdmins'
  | 'canManageEvents'
  | 'canGenerateInvites'
  | 'canManageInvites'
  | 'canManageUshers'
  | 'canViewAnalytics';

export const ALL_PERMISSIONS: Permission[] = [
  'canManageAdmins',
  'canManageEvents',
  'canGenerateInvites',
  'canManageInvites',
  'canManageUshers',
  'canViewAnalytics',
];

export type AdminUser = {
  uid: string;
  email: string;
  displayName: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  active: boolean;
  permissions: Record<Permission, boolean>;
  createdAt: Date;
};

export type InvitationStatus = 'unused' | 'used' | 'revoked';

export type ScanResult =
  | 'accepted'
  | 'already_used'
  | 'revoked'
  | 'invalid'
  | 'wrong_event'
  | 'scanning_disabled';

export type ScanCode =
  | 'ACCEPTED'
  | 'ALREADY_USED'
  | 'REVOKED'
  | 'INVALID'
  | 'WRONG_EVENT'
  | 'SCANNING_DISABLED'
  | 'UNAUTHORIZED'
  | 'EVENT_CLOSED'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR';
