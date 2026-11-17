/**
 * Where to scroll a vertical ScrollView so a field sits near its top while the keyboard covers the
 * view's lower part (T187: Review drafts' endpoint search, whose results list under the box).
 * Pure: no React Native import, so it is tested in Node.
 *
 * - `y`: the field's top in the scroll content (from `measureLayout` against the inner view);
 * - `margin`: room left above it;
 * - `content`: the content's height; `view`: the ScrollView's height;
 * - `covered`: how much of the view the keyboard hides (0 with no keyboard).
 *
 * Never past the point where the content's end meets the keyboard's top: that end is then on screen
 * anyway, and an offset past it would leave blank space until the next drag.
 */
export function revealOffset({ y, margin, content, view, covered }: { y: number; margin: number; content: number; view: number; covered: number }): number {
  const visible = Math.max(0, view - Math.max(0, covered));
  const max = Math.max(0, content - visible);
  return Math.min(Math.max(0, y - margin), max);
}
