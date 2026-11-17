/** The UI system (D266, `docs/ui-plan.md` §3): tokens and primitives. Screens import from here. */

export * from './tokens';
export { contrastRatio, luminance, onFill, readable, tint, tinted } from './contrast';
export { Icon, ICON_NAMES, ICON_PATHS, type IconName } from './icons';
export { Btn, type BtnKind, type BtnProps } from './Btn';
export { Field, fieldStyles, type FieldProps } from './Field';
export { Chip, type ChipProps } from './Chip';
export { Badge, BADGE, pendingBadge, photosBadge, ruleBadge, type BadgeProps, type BadgeTone } from './Badge';
export { Swatch, type SwatchProps } from './Swatch';
export { Card, Row, RowText, Section, type CardProps, type RowProps, type SectionProps } from './Card';
export { Banner, Empty, Toast, type BannerProps, type BannerTone, type EmptyProps, type ToastProps } from './Banner';
export { Sidebar, NAV_GROUPS, navId, type NavName, type SidebarProps } from './Sidebar';
export { Rail, RAIL_WIDTH, railId, type RailProps } from './Rail';
export { PageHeader, FilterRow, FilterLabel, PAGE_GUTTER, type PageHeaderProps } from './Page';
export { Shell, type ShellNav, type ShellProps } from './Shell';
export { NavBar, BackButton, NAV_BAR_H, type NavBarProps, type BackButtonProps } from './NavBar';
export { PanelHeader, type PanelHeaderProps } from './PanelHeader';
export { useBack, useSectionTap, goBack, type Back } from './useNav';
export { backFor, sectionTap, transitionFor, type Section as NavSection } from './navStack';
