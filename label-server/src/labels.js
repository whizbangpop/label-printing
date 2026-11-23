// Brother QL media definitions (printable area in dots at 300 dpi).
// Identifiers match the brother_ql library so the agent can pass them straight through.
// A height of 0 means continuous tape: the template decides the length.

export const LABELS = {
  '12': { name: '12 mm continuous', dots: [106, 0] },
  '29': { name: '29 mm continuous', dots: [306, 0] },
  '38': { name: '38 mm continuous', dots: [413, 0] },
  '50': { name: '50 mm continuous', dots: [554, 0] },
  '54': { name: '54 mm continuous', dots: [590, 0] },
  '62': { name: '62 mm continuous', dots: [696, 0] },
  '17x54': { name: '17 × 54 mm die-cut', dots: [165, 566] },
  '17x87': { name: '17 × 87 mm die-cut', dots: [165, 956] },
  '23x23': { name: '23 × 23 mm die-cut', dots: [202, 202] },
  '29x42': { name: '29 × 42 mm die-cut', dots: [306, 425] },
  '29x90': { name: '29 × 90 mm die-cut', dots: [306, 991] },
  '39x48': { name: '39 × 48 mm die-cut', dots: [425, 495] },
  '39x90': { name: '38 × 90 mm die-cut', dots: [413, 991] },
  '52x29': { name: '52 × 29 mm die-cut', dots: [578, 271] },
  '62x29': { name: '62 × 29 mm die-cut', dots: [696, 271] },
  '62x100': { name: '62 × 100 mm die-cut', dots: [696, 1109] },
};

export const DOTS_PER_MM = 300 / 25.4; // ≈ 11.81

/**
 * Work out the canvas the template is designed on, and the final image size sent to the printer.
 * The printer image is always `printable width` wide; templates with rotate 90/270 are designed
 * "sideways" (long edge horizontal) and rotated before printing.
 */
export function resolveGeometry(template) {
  const label = LABELS[template.label];
  if (!label) throw new Error(`Unknown label "${template.label}" in template ${template.id}`);
  const [across, fixedLength] = label.dots;
  let length = fixedLength;
  if (!length) {
    length = template.length
      ?? (template.lengthMm ? Math.round(template.lengthMm * DOTS_PER_MM) : undefined);
    if (!length) throw new Error(`Template ${template.id} uses continuous tape and needs "length" (dots) or "lengthMm"`);
  }
  const rotate = Number(template.rotate || 0);
  if (![0, 90, 180, 270].includes(rotate)) throw new Error(`Template ${template.id}: rotate must be 0, 90, 180 or 270`);
  const sideways = rotate === 90 || rotate === 270;
  return {
    label,
    rotate,
    continuous: !fixedLength,
    design: sideways ? { width: length, height: across } : { width: across, height: length },
    print: { width: across, height: length },
  };
}
