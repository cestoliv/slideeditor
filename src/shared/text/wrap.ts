/**
 * Measures one line of text and returns its advance width in pixels.
 *
 * The caller binds the font and the scale, so the same layout code serves the
 * stage and the export. The DOM renderer passes a measurer at stage scale, and
 * the exporter passes one at 1080 scale.
 */
export type MeasureText = (line: string) => number;

/**
 * Breaks a string into lines that fit `maxWidth`, ported from wrapText
 * (app.js:4508-4542) with `context.measureText(x).width` replaced by `measure(x)`.
 *
 * Explicit newlines always break, and an empty paragraph survives as an empty
 * line, so a run of newlines keeps its spacing. A word too wide for the line is
 * broken between characters rather than left to overflow. The result always
 * holds at least one line, even for empty input.
 */
export function wrapText(
  value: string,
  maxWidth: number,
  measure: MeasureText,
): string[] {
  // A falsy value becomes a space so the loop below still emits one line.
  const paragraphs = String(value || " ").split("\n");
  const lines: string[] = [];
  paragraphs.forEach((paragraph) => {
    if (paragraph === "") {
      lines.push("");
      return;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (measure(test) <= maxWidth) {
        line = test;
      } else if (line) {
        lines.push(line);
        line = word;
      } else {
        // The word alone overflows an empty line, so it is split by character.
        // Spread rather than split("") so a surrogate pair stays whole.
        const characters = [...word];
        let chunk = "";
        characters.forEach((character) => {
          if (measure(chunk + character) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = character;
          } else {
            chunk += character;
          }
        });
        line = chunk;
      }
    });
    lines.push(line);
  });
  return lines;
}
