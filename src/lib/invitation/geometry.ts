// Approved normalized QR placement derived from the 1070 × 1470 reference
// artwork (spec: QR reference box x=418, y=975, 236×236 → ratios
// 0.390654 / 0.663265 / 0.220561). The QR must be a true square and must
// never be scaled non-uniformly.
export const QR_X_RATIO = 0.390654;
export const QR_Y_RATIO = 0.663265;
export const QR_W_RATIO = 0.220561;

export type TemplateGeometry = {
  canvasWidth: number;
  canvasHeight: number;
  qr: { x: number; y: number; size: number; xRatio: number; yRatio: number; widthRatio: number };
  serial: { enabled: boolean; x: number; y: number; fontSize: number; color: string; plate?: boolean };
};

/** Scales the approved normalized placement to the actual master artwork dimensions. */
export function deriveTemplateGeometry(canvasWidth: number, canvasHeight: number): TemplateGeometry {
  return {
    canvasWidth,
    canvasHeight,
    qr: {
      x: Math.round(QR_X_RATIO * canvasWidth),
      y: Math.round(QR_Y_RATIO * canvasHeight),
      size: Math.round(QR_W_RATIO * canvasWidth),
      xRatio: QR_X_RATIO,
      yRatio: QR_Y_RATIO,
      widthRatio: QR_W_RATIO,
    },
    serial: {
      enabled: true,
      // Directly UNDER the QR, centered on it, on a white plate: the
      // traceable serial must be impossible to miss (owner decision).
      // The old placement — tiny dark-gray text at the extreme bottom
      // edge — was invisible on the approved artwork.
      x: Math.round((QR_X_RATIO + QR_W_RATIO / 2) * canvasWidth),
      y: Math.round(QR_Y_RATIO * canvasHeight + QR_W_RATIO * canvasWidth + 0.075 * canvasHeight),
      fontSize: Math.round(0.032 * canvasWidth),
      color: '#111111',
      plate: true,
    },
  };
}

// Reference: on the exact 1070×1470 artwork these must round back to the
// approved box (418, 975, 236).
export const REFERENCE_CANVAS = { width: 1070, height: 1470 } as const;
export const REFERENCE_QR_BOX = { x: 418, y: 975, size: 236 } as const;

/**
 * Serial-print fallback. Templates uploaded before serial support shipped
 * have no `serial` in their stored geometry (or an older shape) — but the
 * traceable serial ON the card is a core product decision. Generation must
 * never silently skip it: resolve to the approved default overlay when the
 * stored template does not carry an enabled one.
 */
export function resolveSerialGeometry(template: {
  canvasWidth: number;
  canvasHeight: number;
  serial?: { enabled?: boolean; x: number; y: number; fontSize: number; color: string; plate?: boolean };
}): TemplateGeometry['serial'] {
  // ALWAYS use the approved near-QR plate placement. Stored template
  // serials from the pre-plate era carry the invisible bottom-edge
  // placement — honoring them would keep printing cards whose serial
  // nobody can see, which defeats the traceability guarantee.
  return deriveTemplateGeometry(template.canvasWidth, template.canvasHeight).serial;
}
