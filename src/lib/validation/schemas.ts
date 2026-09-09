import { z } from 'zod';

export const permissionSchema = z.object({
  canManageAdmins: z.boolean().optional().default(false),
  canManageEvents: z.boolean().optional().default(false),
  canGenerateInvites: z.boolean().optional().default(false),
  canManageInvites: z.boolean().optional().default(false),
  canManageUshers: z.boolean().optional().default(false),
  canViewAnalytics: z.boolean().optional().default(false),
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

export const toggleScanningSchema = z.object({
  enabled: z.boolean(),
  confirm: z.literal(true),
});

export const createUsherSchema = z.object({
  eventId: z.string().min(4),
  name: z.string().min(2).max(80),
  pin: z
    .string()
    .regex(/^\d{6,10}$/)
    .optional(),
  gateId: z.string().max(40).optional().nullable(),
});

export const updateUsherSchema = z.object({
  active: z.boolean().optional(),
  resetPin: z.boolean().optional(),
  newPin: z
    .string()
    .regex(/^\d{6,10}$/)
    .optional(),
  gateId: z.string().max(40).optional().nullable(),
  name: z.string().min(2).max(80).optional(),
});

export const usherSigninSchema = z.object({
  eventId: z.string().min(4),
  name: z.string().min(1).max(80),
  pin: z.string().regex(/^\d{6,10}$/),
});

// Serverless time/memory safety: share-profile renders are fast, but each
// 8K HQ render is heavy. HQ batches are capped at 20 cards per request —
// run multiple batches instead of gambling on a plan's maxDuration.
export const generateBatchSchema = z
  .object({
    eventId: z.string().min(4),
    quantity: z.number().int().min(1).max(50),
    profile: z.enum(['share', 'hq']).default('share'),
  })
  .superRefine((v, ctx) => {
    if (v.profile === 'hq' && v.quantity > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quantity'],
        message: 'HQ (8K) batches are capped at 20 cards per request. Run multiple batches or use the share profile.',
      });
    }
  });

export const revokeInvitationSchema = z.object({
  reason: z.string().max(300).default(''),
});

export const allowRescanSchema = z.object({
  reason: z.string().min(3).max(300),
});

export const scanSchema = z.object({
  token: z.string().min(10).max(200),
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
  permissions: permissionSchema.optional(),
});
