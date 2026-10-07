// A conversation follows its newest text while the reader is at (or near) the end; once they scroll up to read, it stays put.
export const FOLLOW_SLACK_PX = 80;

export function atEnd(p: { scrollY: number; viewport: number; height: number }, slack = FOLLOW_SLACK_PX): boolean {
  return p.scrollY + p.viewport >= p.height - slack;
}
