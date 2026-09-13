import { z } from 'zod';

export const permissionSchema = z.object({
  canManageAdmins: z.boolean().optional().default(false),
  canManageEvents: z.boolean().optional().default(false),
  canGenerateInvites: z.boolean().optional().default(false),
  canManageInvites: z.boolean().optional().default(false),
  canManageUshers: z.boolean().optional().default(false),
  canViewAnalytics: z.boolean().optional().default(false),
});

/**
 * Same shape as permissionSchema but WITHOUT the `.default(false)` on each
 * key — used for admin UPDATES, where the admins page PATCHes one toggled
 * checkbox at a time (e.g. `{ canManageEvents: true }`). If this instead
 * parsed through permissionSchema, Zod's per-key defaults would silently
 * expand that partial payload into a FULL object with every other
 * permission defaulted to false — undoing updateAdminAccount()'s
 * partial-merge fix before it ever saw the request (root cause of the
 * "can only hold one permission at a time" bug, owner-reported 2026-09-10).
 * permissionSchema itself stays default-filling for admin CREATION, where
 * omitted keys should mean "false", which is correct there.
 */
export const partialPermissionSchema = z.object({
  canManageAdmins: z.boolean().optional(),
  canManageEvents: z.boolean().optional(),
  canGenerateInvites: z.boolean().optional(),
  canManageInvites: z.boolean().optional(),
  canManageUshers: z.boolean().optional(),
  canViewAnalytics: z.boolean().optional(),
});

export const createEventSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'slug: lowercase letters, numbers and dashes only'),
  code: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[A-Za-z0-9]+$/)
    .optional(),
  eventDate: z.string().datetime(),
  timezone: z.string().default('Africa/Lagos'),
});

export const updateEventSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  eventDate: z.string().datetime().optional(),
  lifecycleStatus: z.enum(['draft', 'open', 'closed', 'archived']).optional(),
  templateId: z.string().min(4).optional().nullable(),
});

export const permanentlyDeleteEventSchema = z.object({
  confirmSlug: z.string().min(1),
});

export const toggleScanningSchema = z.object({
  enabled: z.boolean(),
  confirm: z.literal(true),
});

export const createUsherSchema = z.object({
  eventId: z.string().min(4),
  name: z.string().min(2).max(80),
  pin: z
    .string()
    .regex(/^\d{6}$/, 'PIN must be exactly 6 digits')
    .optional(),
  gateId: z.string().max(40).optional().nullable(),
});

export const updateUsherSchema = z.object({
  active: z.boolean().optional(),
  resetPin: z.boolean().optional(),
  newPin: z
    .string()
    .regex(/^\d{6}$/, 'PIN must be exactly 6 digits')
    .optional(),
  gateId: z.string().max(40).optional().nullable(),
  name: z.string().min(2).max(80).optional(),
});

// PIN-only usher sign-in: the PIN alone identifies the usher —
// name and event are resolved server-side and are never submitted.
export const usherSigninSchema = z.object({
  pin: z.string().regex(/^\d{6}$/),
});

// Serverless time/memory safety: share-profile renders are fast, but each
// 8K HQ render is heavy. HQ batches are capped at 20 cards per request —
// run multiple batches instead of gambling on a plan's maxDuration.
export const generateBatchSchema = z
  .object({
    eventId: z.string().min(4),
    quantity: z.number().int().min(1).max(50),
    profile: z.enum(['share', 'hq']).default('share'),
    // Card Type (owner request, 2026-09-12): the UI-facing wrapper around
    // the existing tag mechanism below.
    // - 'regular' (default): general cards, standard serial numbers. Any
    //   tag sent alongside is ignored server-side — see generate/route.ts —
    //   so a client that fails to hide the Tag field can never smuggle one
    //   onto a Regular batch.
    // - 'special': requires a non-empty tag (e.g. "VIP", "FAMILY").
    cardType: z.enum(['regular', 'special']).default('regular'),
    // Flexible card generation (owner request, 2026-09-10):
    // - tag: printed on the card INSTEAD of the serial number (e.g. "FAMILY",
    //   "VIP"). Every card still gets a real serial internally for lookup —
    //   omit tag (or send '') for a normal card that prints its serial.
    // - usageLimit: how many successful scans this card allows before it
    //   locks like today's single-use cards. Omit/null = unlimited uses.
    tag: z
      .string()
      .trim()
      .max(24, 'Tag must be 24 characters or fewer')
      .regex(/^[a-zA-Z0-9 .-]*$/, 'Tag can only contain letters, numbers, spaces, "." and "-"')
      .optional(),
    usageLimit: z.number().int().min(1).max(9999).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.profile === 'hq' && v.quantity > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quantity'],
        message: 'HQ (8K) batches are capped at 20 cards per request. Run multiple batches or use the share profile.',
      });
    }
    if (v.cardType === 'special' && !(v.tag && v.tag.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tag'],
        message: 'A tag is required for Special cards (e.g. VIP, FAMILY).',
      });
    }
  });

// Manual QR position override (owner request, 2026-09-13): {x:null,y:null}
// clears the override back to the default ratio-based position; otherwise
// both must be non-negative integers within the canvas — the route clamps
// to the actual valid range since that depends on canvasWidth/Height and
// the QR's fixed size, which zod alone can't express.
export const templateGeometryOverrideSchema = z
  .object({
    x: z.number().int().min(0).nullable(),
    y: z.number().int().min(0).nullable(),
  })
  .refine((v) => (v.x === null) === (v.y === null), {
    message: 'x and y must both be a position, or both be null to reset to default',
  });

export const revokeInvitationSchema = z.object({
  reason: z.string().max(300).default(''),
});

export const regenerateInvitationSchema = z.object({
  reason: z.string().max(300).default('Regenerated — rendering fix'),
});

export const allowRescanSchema = z.object({
  reason: z.string().min(3).max(300),
});

export const scanSchema = z.object({
  // QR credentials ("IS26.<43 chars>") OR a typed serial number
  // ("ISWED00042", 6+ chars for short event codes) — manual entry.
  token: z.string().min(6).max(200),
  clientRequestId: z.string().min(6).max(80),
  gateId: z.string().max(40).optional().nullable(),
  deviceInfo: z.string().max(200).optional().nullable(),
});

export const heartbeatSchema = z.object({
  gateId: z.string().max(40).optional().nullable(),
});

export const createAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(100),
  displayName: z.string().min(2).max(80),
  permissions: permissionSchema,
});

export const updateAdminSchema = z.object({
  active: z.boolean().optional(),
  displayName: z.string().min(2).max(80).optional(),
  permissions: partialPermissionSchema.optional(),
});
