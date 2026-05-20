/** Theme presets — hobby / style personalities */
const THEME_PRESETS = {
  upwork: {
    id: 'upwork',
    name: 'Upwork Pro',
    emoji: '💼',
    vars: {
      '--bg': '#0f1419',
      '--surface': '#1a2332',
      '--border': '#2d3a4f',
      '--text': '#e7ecf3',
      '--muted': '#8b9cb3',
      '--accent': '#14a800',
      '--accent-dim': '#0d7a00',
      '--accent-soft': '#5ddb4a',
      '--danger': '#ff6b6b',
      '--warn': '#ffb347',
      '--info': '#5b9cf5',
      '--header-from': '#1a2332',
      '--header-to': '#0f1419',
      '--card-overlay': '0.92'
    }
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean Dive',
    emoji: '🌊',
    vars: {
      '--bg': '#0a1628',
      '--surface': '#122a45',
      '--border': '#1e4a6e',
      '--text': '#e8f4fc',
      '--muted': '#7eb8d8',
      '--accent': '#00b4d8',
      '--accent-dim': '#0077b6',
      '--accent-soft': '#90e0ef',
      '--danger': '#ff6b6b',
      '--warn': '#ffd166',
      '--info': '#48cae4',
      '--header-from': '#123a5c',
      '--header-to': '#0a1628',
      '--card-overlay': '0.9'
    }
  },
  forest: {
    id: 'forest',
    name: 'Forest Trail',
    emoji: '🌲',
    vars: {
      '--bg': '#0d1a12',
      '--surface': '#1a2e1f',
      '--border': '#2d4a35',
      '--text': '#e8f5e9',
      '--muted': '#8fbc8f',
      '--accent': '#4caf50',
      '--accent-dim': '#2e7d32',
      '--accent-soft': '#81c784',
      '--danger': '#ef5350',
      '--warn': '#ffb74d',
      '--info': '#66bb6a',
      '--header-from': '#1b3a24',
      '--header-to': '#0d1a12',
      '--card-overlay': '0.9'
    }
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset Photo',
    emoji: '🌅',
    vars: {
      '--bg': '#1a0f14',
      '--surface': '#2d1a22',
      '--border': '#4a2c38',
      '--text': '#fff0f3',
      '--muted': '#d4a5b5',
      '--accent': '#ff6b35',
      '--accent-dim': '#e55a2b',
      '--accent-soft': '#ff9f7a',
      '--danger': '#ff4757',
      '--warn': '#ffc048',
      '--info': '#f783ac',
      '--header-from': '#3d2030',
      '--header-to': '#1a0f14',
      '--card-overlay': '0.9'
    }
  },
  gaming: {
    id: 'gaming',
    name: 'Neon Gaming',
    emoji: '🎮',
    vars: {
      '--bg': '#0d0221',
      '--surface': '#1a1035',
      '--border': '#3d2a6b',
      '--text': '#f0e6ff',
      '--muted': '#a78bfa',
      '--accent': '#00f5d4',
      '--accent-dim': '#00bbf9',
      '--accent-soft': '#7bffc9',
      '--danger': '#ff006e',
      '--warn': '#ffbe0b',
      '--info': '#9b5de5',
      '--header-from': '#240046',
      '--header-to': '#0d0221',
      '--card-overlay': '0.88'
    }
  },
  coffee: {
    id: 'coffee',
    name: 'Coffee Shop',
    emoji: '☕',
    vars: {
      '--bg': '#1c1410',
      '--surface': '#2a2018',
      '--border': '#4a3c32',
      '--text': '#f5ebe0',
      '--muted': '#c4a484',
      '--accent': '#d4a373',
      '--accent-dim': '#a98467',
      '--accent-soft': '#e9c46a',
      '--danger': '#e76f51',
      '--warn': '#f4a261',
      '--info': '#bc8a5f',
      '--header-from': '#3d2c24',
      '--header-to': '#1c1410',
      '--card-overlay': '0.9'
    }
  },
  lavender: {
    id: 'lavender',
    name: 'Lavender Art',
    emoji: '🎨',
    vars: {
      '--bg': '#15121f',
      '--surface': '#221c32',
      '--border': '#3d3558',
      '--text': '#f3eef8',
      '--muted': '#b8a9c9',
      '--accent': '#b388ff',
      '--accent-dim': '#7c4dff',
      '--accent-soft': '#d1b3ff',
      '--danger': '#ff5252',
      '--warn': '#ffd54f',
      '--info': '#ea80fc',
      '--header-from': '#2a2240',
      '--header-to': '#15121f',
      '--card-overlay': '0.9'
    }
  },
  minimal: {
    id: 'minimal',
    name: 'Clean Light',
    emoji: '✨',
    vars: {
      '--bg': '#f4f5f7',
      '--surface': '#ffffff',
      '--border': '#dde1e6',
      '--text': '#1a1d21',
      '--muted': '#6b7280',
      '--accent': '#2563eb',
      '--accent-dim': '#1d4ed8',
      '--accent-soft': '#3b82f6',
      '--danger': '#dc2626',
      '--warn': '#d97706',
      '--info': '#0891b2',
      '--header-from': '#ffffff',
      '--header-to': '#eef2f7',
      '--card-overlay': '0.95'
    }
  },
  rose: {
    id: 'rose',
    name: 'Rose Gold',
    emoji: '🌸',
    vars: {
      '--bg': '#1a1218',
      '--surface': '#2a1f28',
      '--border': '#4a3545',
      '--text': '#fceef3',
      '--muted': '#d4a5b9',
      '--accent': '#f48fb1',
      '--accent-dim': '#ec407a',
      '--accent-soft': '#f8bbd9',
      '--danger': '#ff5252',
      '--warn': '#ffb74d',
      '--info': '#ce93d8',
      '--header-from': '#352530',
      '--header-to': '#1a1218',
      '--card-overlay': '0.9'
    }
  }
};

const DEFAULT_APPEARANCE = {
  themeId: 'upwork',
  backgroundImage: null,
  backgroundOpacity: 0.25
};
