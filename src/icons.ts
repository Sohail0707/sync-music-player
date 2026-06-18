// =============================================================================
// icons.ts — ALL SVG ICONS IN ONE PLACE (easy to swap)
// -----------------------------------------------------------------------------
// HOW TO REPLACE AN ICON:
//   Paste any 24x24 SVG as the value. Keep these rules so it inherits theme
//   color + sizing automatically:
//     • keep   viewBox="0 0 24 24"
//     • use    fill="currentColor"   (for solid icons)  OR
//              fill="none" stroke="currentColor"  (for line icons)
//     • do NOT hardcode width/height — CSS sizes them.
//   Example: grab any icon from lucide.dev / heroicons.com and drop it in.
// =============================================================================

export const icons = {
  // Transport
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.79-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.4"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5.5v13l9-6.5z"/><rect x="16.5" y="5" width="2.8" height="14" rx="1.2"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 5.5v13l-9-6.5z"/><rect x="4.7" y="5" width="2.8" height="14" rx="1.2"/></svg>`,
  forward: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.2v11.6L11 12zM12.5 6.2v11.6L20.5 12z"/></svg>`,
  rewind: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 6.2v11.6L13 12zM11.5 6.2v11.6L3.5 12z"/></svg>`,

  // Bottom function bar
  add: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  qr: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3.5v3.5M21 14v7h-7v-3.5"/></svg>`,
  leave: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 16l-4-4 4-4"/><path d="M5 12h11"/></svg>`,

  // Header / misc
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 6"/><path d="M18 20a5.5 5.5 0 0 0-2.5-4.6"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>`
} as const;

export type IconName = keyof typeof icons;
