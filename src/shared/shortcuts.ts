export type ShortcutActionId =
  | 'playPause'
  | 'shuttleReverse'
  | 'shuttlePause'
  | 'shuttleForward'
  | 'stepBack'
  | 'stepForward'
  | 'split'
  | 'deleteClip'
  | 'rippleDelete'
  | 'markIn'
  | 'markOut'
  | 'clearInOut'
  | 'addMarker'
  | 'selectTool'
  | 'cutTool'
  | 'toggleSnap'
  | 'toggleLoop'
  | 'toggleSticky'
  | 'toggleStrip'
  | 'toggleSkim'
  | 'fullscreen'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomToFit'
  | 'selectAll'
  | 'copyClips'
  | 'cutClips'
  | 'pasteClips'
  | 'undo'
  | 'redo'
  | 'copyGrade'
  | 'pasteGrade'
  | 'importMedia'
  | 'saveProject'
  | 'exportVideo'
  | 'magic';

export interface ShortcutBinding {
  id: ShortcutActionId;
  label: string;
  combo: string;
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { id: 'playPause', label: 'Play / Pause', combo: 'Space' },
  { id: 'shuttleReverse', label: 'Shuttle Reverse', combo: 'J' },
  { id: 'shuttlePause', label: 'Shuttle Pause', combo: 'K' },
  { id: 'shuttleForward', label: 'Shuttle Forward', combo: 'L' },
  { id: 'stepBack', label: 'Previous Frame', combo: 'ArrowLeft' },
  { id: 'stepForward', label: 'Next Frame', combo: 'ArrowRight' },
  { id: 'split', label: 'Split at Playhead', combo: 'S' },
  { id: 'deleteClip', label: 'Delete Selected', combo: 'Delete' },
  { id: 'rippleDelete', label: 'Ripple Delete', combo: 'Shift+Delete' },
  { id: 'markIn', label: 'Mark In Point', combo: 'I' },
  { id: 'markOut', label: 'Mark Out Point', combo: 'O' },
  { id: 'clearInOut', label: 'Clear In / Out', combo: 'Alt+X' },
  { id: 'addMarker', label: 'Add Marker', combo: 'M' },
  { id: 'selectTool', label: 'Select Tool', combo: 'V' },
  { id: 'cutTool', label: 'Cut Tool', combo: 'C' },
  { id: 'toggleSnap', label: 'Toggle Snapping', combo: 'N' },
  { id: 'toggleSticky', label: 'Sticky Edges', combo: 'R' },
  { id: 'toggleStrip', label: 'Toggle Filmstrips', combo: 'Shift+T' },
  { id: 'toggleSkim', label: 'Toggle Skimming', combo: 'Y' },
  { id: 'toggleLoop', label: 'Toggle Loop', combo: 'Ctrl+L' },
  { id: 'fullscreen', label: 'Fullscreen Viewer', combo: 'F' },
  { id: 'zoomIn', label: 'Zoom Timeline In', combo: '=' },
  { id: 'zoomOut', label: 'Zoom Timeline Out', combo: '-' },
  { id: 'zoomToFit', label: 'Zoom to Fit', combo: 'Shift+Z' },
  { id: 'selectAll', label: 'Select All Clips', combo: 'Ctrl+A' },
  { id: 'copyClips', label: 'Copy Clips', combo: 'Ctrl+C' },
  { id: 'cutClips', label: 'Cut Clips', combo: 'Ctrl+X' },
  { id: 'pasteClips', label: 'Paste Clips', combo: 'Ctrl+V' },
  { id: 'undo', label: 'Undo', combo: 'Ctrl+Z' },
  { id: 'redo', label: 'Redo', combo: 'Ctrl+Shift+Z' },
  { id: 'copyGrade', label: 'Copy Color Grade', combo: 'Ctrl+Alt+C' },
  { id: 'pasteGrade', label: 'Paste Color Grade', combo: 'Ctrl+Alt+V' },
  { id: 'importMedia', label: 'Import Media', combo: 'Ctrl+I' },
  { id: 'saveProject', label: 'Save Project', combo: 'Ctrl+S' },
  { id: 'exportVideo', label: 'Export Video', combo: 'Ctrl+E' },
  { id: 'magic', label: 'Open Magic Bar', combo: 'Ctrl+K' },
];

export function formatEventCombo(e: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  key: string;
}): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key === '+') key = '=';
  else if (key === 'Backspace') key = 'Delete';
  else if (key.length === 1) key = key.toUpperCase();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  parts.push(key);
  return parts.join('+');
}

export function mergeShortcutBindings(saved?: Partial<Record<ShortcutActionId, string>>): ShortcutBinding[] {
  return DEFAULT_SHORTCUTS.map((b) => ({
    ...b,
    combo: saved && saved[b.id] !== undefined ? saved[b.id]! : b.combo,
  }));
}
