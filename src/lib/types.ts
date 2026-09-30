export type Permission =
  | 'canManageAdmins'
  | 'canManageEvents'
  | 'canGenerateInvites'
  | 'canManageInvites'
  | 'canManageUshers'
  | 'canViewAnalytics'
  | 'canViewMoments'
  | 'canDeleteMoments'
  | 'canShareMoments';

export const ALL_PERMISSIONS: Permission[] = [
  'canManageAdmins',
  'canManageEvents',
  'canGenerateInvites',
  'canManageInvites',
  'canManageUshers',
  'canViewAnalytics',
  'canViewMoments',
  'canDeleteMoments',
  'canShareMoments',
];

export type AdminUser = {
  uid: string;
  email: string;
  displayName: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  active: boolean;
  permissions: Record<Permission, boolean>;
  /** Events whose guest moments this admin may open. Root admin: all. Empty/absent: none. */
  momentsEventIds?: string[];
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
