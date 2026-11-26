export type AppThemeName = 'dark' | 'grey' | 'amber' | 'light';

export interface ThemePalette {
  name: AppThemeName;
  isLight: boolean;
  bg: string;
  panel: string;
  lane: string;
  laneAlt: string;
  raised: string;
  field: string;
  stroke: string;
  hover: string;
  text: string;
  textDim: string;
  textFaint: string;
  onText: string;
  accent: string;
  video: string;
  audio: string;
  textClip: string;
  clipStroke: string;
  offline: string;
  hint: string;
  well: string;
  control: string;
  button: string;
  buttonHover: string;
  transport: string;
  outline: string;
  meterLow: string;
  chip: string;
  sheet: string;
  sheetField: string;
  sheetFieldHover: string;
  sheetFieldStroke: string;
  sheetLabel: string;
}

export const THEMES: Record<AppThemeName, ThemePalette> = {
  dark: {
    name: 'dark',
    isLight: false,
    bg: '#0A0A0A',
    panel: '#111111',
    lane: '#0D0D0D',
    laneAlt: '#0A0A0A',
    raised: '#1A1A1A',
    field: '#181818',
    stroke: 'rgba(255, 255, 255, 0.085)',
    hover: 'rgba(255, 255, 255, 0.07)',
    text: '#F2F2F0',
    textDim: '#9A9A96',
    textFaint: '#5C5C59',
    onText: '#0A0A0A',
    accent: '#FF4A1C',
    video: '#1E1E1E',
    audio: '#151515',
    textClip: '#1B1B1B',
    clipStroke: '#2C2C2C',
    offline: '#5A1F1F',
    hint: '#3E3E3C',
    well: '#262626',
    control: '#3A3A3A',
    button: '#242424',
    buttonHover: '#2E2E2E',
    transport: '#161616',
    outline: '#2C2C2C',
    meterLow: '#D9D9D6',
    chip: '#C9C9C5',
    sheet: '#141414',
    sheetField: '#1E1E1E',
    sheetFieldHover: '#262626',
    sheetFieldStroke: '#2E2E2E',
    sheetLabel: '#A8A8A4',
  },
  grey: {
    name: 'grey',
    isLight: false,
    bg: '#1C1C1C',
    panel: '#232323',
    lane: '#1F1F1F',
    laneAlt: '#1C1C1C',
    raised: '#2D2D2D',
    field: '#2A2A2A',
    stroke: 'rgba(255, 255, 255, 0.09)',
    hover: 'rgba(255, 255, 255, 0.07)',
    text: '#F2F2F0',
    textDim: '#A6A6A2',
    textFaint: '#6F6F6C',
    onText: '#1C1C1C',
    accent: '#FF4A1C',
    video: '#333333',
    audio: '#2A2A2A',
    textClip: '#303030',
    clipStroke: '#444444',
    offline: '#6A2A2A',
    hint: '#585856',
    well: '#383838',
    control: '#4C4C4C',
    button: '#363636',
    buttonHover: '#404040',
    transport: '#2A2A2A',
    outline: '#444444',
    meterLow: '#D9D9D6',
    chip: '#CFCFCB',
    sheet: '#262626',
    sheetField: '#303030',
    sheetFieldHover: '#383838',
    sheetFieldStroke: '#444444',
    sheetLabel: '#B2B2AE',
  },
  amber: {
    name: 'amber',
    isLight: false,
    bg: '#14110E',
    panel: '#1A1612',
    lane: '#17130F',
    laneAlt: '#14110E',
    raised: '#25201A',
    field: '#221D18',
    stroke: 'rgba(255, 224, 180, 0.09)',
    hover: 'rgba(255, 224, 180, 0.07)',
    text: '#F4EDE2',
    textDim: '#A89B8B',
    textFaint: '#695E52',
    onText: '#14110E',
    accent: '#FF6A2B',
    video: '#29231D',
    audio: '#211C17',
    textClip: '#26201A',
    clipStroke: '#3A3229',
    offline: '#6A251F',
    hint: '#4B433A',
    well: '#2C261F',
    control: '#433B31',
    button: '#2B251E',
    buttonHover: '#362E26',
    transport: '#1F1B16',
    outline: '#3A3229',
    meterLow: '#E0D6C8',
    chip: '#D0C5B6',
    sheet: '#1D1914',
    sheetField: '#28221C',
    sheetFieldHover: '#312A23',
    sheetFieldStroke: '#3E352C',
    sheetLabel: '#B5A898',
  },
  light: {
    name: 'light',
    isLight: true,
    bg: '#F3F3F1',
    panel: '#EAEAE7',
    lane: '#EFEFEC',
    laneAlt: '#F3F3F1',
    raised: '#FFFFFF',
    field: '#E3E3DF',
    stroke: 'rgba(0, 0, 0, 0.09)',
    hover: 'rgba(0, 0, 0, 0.055)',
    text: '#161614',
    textDim: '#62625D',
    textFaint: '#9A9A94',
    onText: '#FFFFFF',
    accent: '#FF4A1C',
    video: '#262626',
    audio: '#1D1D1D',
    textClip: '#222222',
    clipStroke: '#383838',
    offline: '#7A2A2A',
    hint: '#B2B2AC',
    well: '#DCDCD7',
    control: '#C6C6C0',
    button: '#DFDFDA',
    buttonHover: '#D4D4CE',
    transport: '#E5E5E0',
    outline: '#CFCFC9',
    meterLow: '#2E2E2B',
    chip: '#444440',
    sheet: '#F7F7F5',
    sheetField: '#EAEAE6',
    sheetFieldHover: '#E0E0DB',
    sheetFieldStroke: '#D0D0CA',
    sheetLabel: '#60605B',
  },
};
