import { describe, expect, it } from 'vitest';
import { updateAdminSchema, partialPermissionSchema, permissionSchema } from '@/lib/validation/schemas';

describe('admin permission schemas (owner-reported bug, 2026-09-10)', () => {
  it('permissionSchema (admin CREATION) fills omitted keys to false — correct there', () => {
    const parsed = permissionSchema.parse({ canManageEvents: true });
    expect(parsed).toEqual({
      canManageAdmins: false,
      canManageEvents: true,
      canGenerateInvites: false,
      canManageInvites: false,
      canManageUshers: false,
      canViewAnalytics: false,
    });
  });

  it('partialPermissionSchema (admin UPDATE) leaves omitted keys OUT entirely — must not default-fill', () => {
    const parsed = partialPermissionSchema.parse({ canManageEvents: true });
    expect(parsed).toEqual({ canManageEvents: true });
    expect('canManageAdmins' in parsed).toBe(false);
    expect('canViewAnalytics' in parsed).toBe(false);
  });

  it('updateAdminSchema on a single-checkbox PATCH body preserves only the toggled key', () => {
    // This is exactly the payload the admins page sends on one checkbox
    // onChange. If this ever regresses back to permissionSchema, every
    // other permission would reappear here as `false` and silently wipe
    // out any permission not included in this specific request.
    const res = updateAdminSchema.safeParse({ permissions: { canManageUshers: true } });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.permissions).toEqual({ canManageUshers: true });
    }
  });
});
