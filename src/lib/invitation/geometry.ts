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
  serial: { enabled: boolean; x: number; y: number; fontSize: number; color: string };
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
      x: Math.round(canvasWidth / 2),
      y: Math.round(canvasHeight - canvasHeight * 0.02),
      fontSize: Math.round(canvasWidth * 0.024),
      color: '#4a4a4a',
    },
  };
}

// Reference: on the exact 1070×1470 artwork these must round back to the
// approved box (418, 975, 236).
export const REFERENCE_CANVAS = { width: 1070, height: 1470 } as const;
export const REFERENCE_QR_BOX = { x: 418, y: 975, size: 236 } as const;
