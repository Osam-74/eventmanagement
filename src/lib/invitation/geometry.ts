// Approved normalized QR placement derived from the 1070 × 1470 reference
// artwork (spec: QR reference box x=418, y=975, 236×236 → ratios
// 0.390654 / 0.663265 / 0.220561). The QR must be a true square and must
// never be scaled non-uniformly.
//
// Owner nudge (2026-09-11): the whole block — QR (and therefore its gold
// box), the "ACCESS CODE" label, and the serial — moved UP 15px together
// at the reference canvas (975 -> 960 for the QR's y). Only QR_Y_RATIO
// changes here; the label and serial are both computed as offsets from
// the QR's own position (see accessLabelGeometryBelowQr /
// serialGeometryBelowQr below), so shifting the QR up carries the whole
// group with it, preserving the spacing between them exactly.
export const QR_X_RATIO = 0.390654;
export const QR_Y_RATIO = 0.653061; // was 0.663265 (975px); -15px at the 1470-tall reference -> 960px
export const QR_W_RATIO = 0.220561;

// Same gold already used for the printed serial (#C5A059) — reused here so
// the QR box, the "ACCESS CODE" label, and the serial all read as one
// consistent brand treatment.
export const QR_BOX_GOLD = '#C5A059';

export type QrBoxGeometry = {
  color: string;
  // All three ratios are relative to qr.size, so the box scales cleanly
  // with the QR at every output resolution, just like the QR itself.
  strokeWidthRatio: number;
  paddingRatio: number;
  cornerRadiusRatio: number;
};

export type AccessLabelGeometry = {
  enabled: boolean;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  letterSpacing: number;
  color: string;
};

export type TemplateGeometry = {
  canvasWidth: number;
  canvasHeight: number;
  qr: { x: number; y: number; size: number; xRatio: number; yRatio: number; widthRatio: number };
  // Caption drawn directly under the QR, above the serial — see
  // accessLabelGeometryBelowQr() below.
  accessLabel: AccessLabelGeometry;
  serial: { enabled: boolean; x: number; y: number; fontSize: number; color: string; plate?: boolean };
  qrBox: QrBoxGeometry;
};

/**
 * Owner decision (2026-09-11): EVERY template gets a gold box drawn around
 * its QR automatically, unconditionally — no per-template opt-in, no
 * artwork-drawn frame required. This is the one place that look is
 * defined.
 */
export function defaultQrBox(): QrBoxGeometry {
  return {
    color: QR_BOX_GOLD,
    strokeWidthRatio: 0.022,
    paddingRatio: 0.07,
    cornerRadiusRatio: 0.03,
  };
}

/**
 * Fills in any missing pieces of a stored qrBox with the approved
 * defaults. A template document written before this feature existed has
 * no qrBox field at all (or may carry an old `{ style: 'template' }`
 * shape from a short-lived opt-in version) — both resolve to the same
 * drawn gold box now, so every template — old or new — gets it the next
 * time a card is generated or regenerated, with no migration needed.
 */
export function resolveQrBoxGeometry(stored?: Partial<QrBoxGeometry> | null): QrBoxGeometry {
  const base = defaultQrBox();
  return {
    color: stored?.color ?? base.color,
    strokeWidthRatio: stored?.strokeWidthRatio ?? base.strokeWidthRatio,
    paddingRatio: stored?.paddingRatio ?? base.paddingRatio,
    cornerRadiusRatio: stored?.cornerRadiusRatio ?? base.cornerRadiusRatio,
  };
}

/**
 * "ACCESS CODE" caption, drawn directly under the QR, above the serial.
 *
 * Owner report (2026-09-11): the master artwork was assumed to already
 * carry this label baked into its pixels — it does not, so generated
 * cards came out with no label at all. Fixed the same way the serial
 * already is: drawn by the renderer itself as vector paths (see
 * serialGlyphs.ts — sharp's SVG <text> renders through fontconfig, which
 * has no usable fonts on Vercel's serverless image, so it must never be
 * plain <text>), so it is guaranteed present on every card regardless of
 * what the artwork does or doesn't contain.
 */
export function accessLabelGeometryBelowQr(
  qr: { x: number; y: number; size: number },
  canvasWidth: number,
  canvasHeight: number
): AccessLabelGeometry {
  return {
    enabled: true,
    text: 'ACCESS CODE',
    x: Math.round(qr.x + qr.size / 2),
    // Sits in the gap between the QR and the serial, closer to the QR.
    // Owner nudge (2026-09-11): +15px at the reference canvas (was 34px
    // below the QR, now 49px — ratio 49/1470) to open a touch more
    // breathing room right under the QR.
    y: Math.round(qr.y + qr.size + 0.0333333 * canvasHeight),
    fontSize: Math.round(0.0131 * canvasWidth),
    letterSpacing: Math.round(0.0131 * canvasWidth * 0.22),
    color: QR_BOX_GOLD,
  };
}

/**
 * Serial placement, derived directly from the ACTUAL qr box being rendered
 * — never recomputed independently from fixed reference ratios. Before this
 * fix, `resolveSerialGeometry` recalculated the serial's position from the
 * canvas size alone using the reference-artwork ratios, completely
 * disconnected from wherever `qr` actually was on THIS template. On any
 * artwork whose real QR box doesn't fall exactly on that reference ratio,
 * the serial landed somewhere unrelated to the QR — anywhere from off-card
 * to on top of other artwork — instead of "immediately below it". Deriving
 * from the real qr box makes "directly under the QR" true by construction,
 * for every template, always.
 */
export function serialGeometryBelowQr(
  qr: { x: number; y: number; size: number },
  canvasWidth: number,
  canvasHeight: number
): TemplateGeometry['serial'] {
  return {
    enabled: true,
    // Directly UNDER the QR, centered on it. Owner decisions (2026-09-10 /
    // 2026-09-11): half the previous size, gold text, no background
    // plate; font size then increased another 4px (2026-09-11) — was
    // 17px at the 1070-wide reference, now 21px (ratio 0.0196262 ≈
    // 21/1070). Vertical offset pushed down from the original tuned
    // value (0.0505) to 0.0645 of canvasHeight to leave clearance under
    // the new "ACCESS CODE" label directly above it.
    // Owner nudge (2026-09-11): moved UP from the previous offset (95px at
    // the reference canvas) to 81px, so the gap to the "ACCESS CODE" label
    // right above it is a moderate ~32px, not the ~61px gap before —
    // still comfortably clear of the label's glyphs (which sit entirely
    // above their own baseline, ~16px tall at this font size).
    x: Math.round(qr.x + qr.size / 2),
    y: Math.round(qr.y + qr.size + 0.0551020 * canvasHeight),
    fontSize: Math.round(0.0196262 * canvasWidth),
    color: '#C5A059',
    plate: false,
  };
}

/**
 * Scales the approved normalized placement to the actual master artwork
 * dimensions. Every template gets the gold QR box and "ACCESS CODE" label
 * automatically — there is no opt-out and nothing to pass in.
 */
export function deriveTemplateGeometry(canvasWidth: number, canvasHeight: number): TemplateGeometry {
  const qr = {
    x: Math.round(QR_X_RATIO * canvasWidth),
    y: Math.round(QR_Y_RATIO * canvasHeight),
    size: Math.round(QR_W_RATIO * canvasWidth),
    xRatio: QR_X_RATIO,
    yRatio: QR_Y_RATIO,
    widthRatio: QR_W_RATIO,
  };
  return {
    canvasWidth,
    canvasHeight,
    qr,
    accessLabel: accessLabelGeometryBelowQr(qr, canvasWidth, canvasHeight),
    serial: serialGeometryBelowQr(qr, canvasWidth, canvasHeight),
    qrBox: defaultQrBox(),
  };
}

// Reference: on the exact 1070×1470 artwork these must round back to the
// approved box, now (418, 960, 236) after the -15px owner nudge above
// (was 418, 975, 236).
export const REFERENCE_CANVAS = { width: 1070, height: 1470 } as const;
export const REFERENCE_QR_BOX = { x: 418, y: 960, size: 236 } as const;

/**
 * Access-label fallback. Same reasoning as resolveSerialGeometry below:
 * ALWAYS resolve to the approved near-QR placement, anchored to THIS
 * template's real qr box, so every template — including the one active
 * right now, which predates this feature and has no accessLabel stored at
 * all — gets the label on its very next generated or regenerated card,
 * with no database migration required.
 */
export function resolveAccessLabelGeometry(template: {
  canvasWidth: number;
  canvasHeight: number;
  qr: { x: number; y: number; size: number };
}): AccessLabelGeometry {
  return accessLabelGeometryBelowQr(template.qr, template.canvasWidth, template.canvasHeight);
}

/**
 * Serial-print fallback. Templates uploaded before serial support shipped
 * have no `serial` in their stored geometry (or an older shape) — but the
 * traceable serial ON the card is a core product decision. Generation must
 * never silently skip it: resolve to the approved near-QR placement,
 * computed from THIS template's actual stored qr box, when the stored
 * template does not carry an enabled one.
 */
export function resolveSerialGeometry(template: {
  canvasWidth: number;
  canvasHeight: number;
  qr: { x: number; y: number; size: number };
  serial?: { enabled?: boolean; x: number; y: number; fontSize: number; color: string; plate?: boolean };
}): TemplateGeometry['serial'] {
  // ALWAYS use the approved near-QR placement, anchored to the real qr box.
  // Stored template serials from an earlier era carry the old size/color/
  // plate — honoring them would keep printing cards with the outdated
  // look instead of the current approved gold, half-size, plate-free style.
  return serialGeometryBelowQr(template.qr, template.canvasWidth, template.canvasHeight);
}
