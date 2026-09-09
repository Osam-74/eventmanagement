import { describe, expect, it } from 'vitest';
import { grantablePermissions, actorHasPermission } from '@/lib/services/admins';
import { emptyPermissions, hasPermission } from '@/lib/api/helpers';

const root = { accountType: 'ROOT_ADMIN' as const, permissions: {} };
const limited = {
  accountType: 'ADMIN' as const,
  permissions: { ...emptyPermissions(), canManageUshers: true },
};
const none = { accountType: 'ADMIN' as const, permissions: {} };

describe('capability checks', () => {
  it('root admin bypasses capability checks', () => {
    expect(actorHasPermission(root, 'canManageAdmins')).toBe(true);
    expect(hasPermission({ accountType: 'ROOT_ADMIN' } as never, 'canGenerateInvites')).toBe(true);
  });

  it('admin only has explicitly granted capabilities', () => {
    expect(actorHasPermission(limited, 'canManageUshers')).toBe(true);
    expect(actorHasPermission(limited, 'canManageAdmins')).toBe(false);
    expect(actorHasPermission(none, 'canManageUshers')).toBe(false);
  });
});

describe('anti-escalation grant computation', () => {
  it('drops every capability the actor does not possess', () => {
    const granted = grantablePermissions(limited, {
      canManageUshers: true,
      canGenerateInvites: true, // actor does NOT have this
      canManageAdmins: true, // actor does NOT have this
    });
    expect(granted.canManageUshers).toBe(true);
    expect(granted.canGenerateInvites).toBe(false);
    expect(granted.canManageAdmins).toBe(false);
  });

  it('root admin can grant everything', () => {
    const granted = grantablePermissions(root, { canManageAdmins: true, canViewAnalytics: true });
    expect(granted.canManageAdmins).toBe(true);
    expect(granted.canViewAnalytics).toBe(true);
  });

  it('grants nothing when nothing grantable is requested', () => {
    expect(grantablePermissions(limited, {})).toEqual(emptyPermissions());
    expect(grantablePermissions(limited, { canGenerateInvites: true })).toEqual(emptyPermissions());
  });
});
