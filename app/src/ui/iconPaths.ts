/**
 * The icons' path data (D266 (7)): the boards' 24-unit stroke SVGs, one string per name, drawn by
 * `Icon` (`icons.tsx`) with Skia. Pure data, so `iconPaths.test.ts` checks it in Node.
 *
 * A board icon made of several `<path>`s is joined into one string. Every sub-path after the first
 * starts with an absolute `M`: a relative `m` after a `z` or an arc moves from wherever the last
 * sub-path ended, not from the origin as it does at the start of an SVG `<path>` (T176 found the
 * sidebar icons drawn off the grid that way).
 */

export const ICON_PATHS = {
  // marks
  check: 'm5 12 5 5 9-10',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  plusCircle: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 8v8M8 12h8',
  checkCircle: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8.5 12.5l2.5 2.5 4.5-5',
  info: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 11v5M12 8h.01',
  warning: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  error: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 8v5M12 16h.01',
  spinner: 'M12 3a9 9 0 1 1-6.4 2.6',
  more: 'M3 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M17 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  // chevrons
  chevronRight: 'm9 5 7 7-7 7',
  chevronLeft: 'm15 5-7 7 7 7',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm6 15 6-6 6 6',
  // the sidebar (T176), as the "Levels · the shell" board draws each entry
  levels: 'M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5',
  review: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8.5 12.5l2.5 2.5 4.5-5',
  cable: 'M3 7h7a4 4 0 0 1 4 4v2a4 4 0 0 0 4 4h3M1.5 7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M19.5 17a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  dashboard: 'M5 20v-7M11 20V5M17 20v-10M3 20h18',
  rulings: 'M3 21l6-6M9 7l8 8M11 5l2-2 8 8-2 2zM5 11l2-2 8 8-2 2z',
  lint: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3zM9 12l2 2 4-4',
  export: 'M12 3v12M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  setup: 'M4 7h9M19 7h1M4 17h3M13 17h7M13.5 7a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M7.5 17a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
  vocabulary: 'M9 6h12M9 12h12M9 18h12M2.8 6a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0M2.8 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0M2.8 18a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0',
  library: 'M12 2 3 7v10l9 5 9-5V7l-9-5zM3 7l9 5 9-5M12 12v10',
  sync: 'M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  user: 'M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  // sync states
  lock: 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4',
  download: 'M12 10v10M8 16l4 4 4-4M20 16.5A4.5 4.5 0 0 0 18 8a6 6 0 0 0-11.5 1.5A4.5 4.5 0 0 0 5 18',
  offline: 'M7 18a5 5 0 0 1-1-9.9A6 6 0 0 1 16.5 6M19 10.5a4 4 0 0 1 0 7.5M3 3l18 18',
  // the plan (T177)
  search: 'M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  ink: 'm4 20 4-1L18 9l-3-3L5 16l-1 4zM13 8l3 3',
  layers: 'M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5M3 18l9 5 9-5',
  grid: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 9h18M3 15h18M9 3v18M15 3v18',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  legend: 'M5 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0M7 14l-3 6h6zM17 14l3 3-3 3-3-3z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM9 13a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  image: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 16l5-5 4 4 3-3 6 6M15.5 9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  sidePanel: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 4v16',
} as const;

export type IconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
